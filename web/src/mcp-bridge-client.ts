// ---------------------------------------------------------------------------
// MCP Bridge Client — singleton MCP SDK client pointing at `/mcp`
//
// Lazily constructs an MCP SDK `Client` wired to a
// `StreamableHTTPClientTransport` targeting the platform's streamable HTTP
// endpoint. Used by the iframe bridge (Task 008) to route `tools/call`,
// `resources/read`, and the tasks lifecycle through MCP instead of REST.
//
// Auth headers are generated per-request via a custom `fetch` in the
// transport options so token refresh via `api/fetch-with-refresh` is not
// bypassed. Headers must NOT be cached at construction — the browser tab
// outlives individual tokens.
// ---------------------------------------------------------------------------

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getActiveWorkspaceId, getAuthToken, setAuthLifecycleHandler } from "./api/client";

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

interface Entry {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

// We cache the in-flight Promise, not the resolved Client, so concurrent
// callers race a single `initialize` handshake rather than creating duplicate
// transports. A rejected init clears the cache so the next caller retries.
let pending: Promise<Entry> | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the singleton MCP bridge `Client`, initializing it on first call.
 *
 * - Lazy: the transport and `initialize` handshake happen on first invocation.
 * - Singleton: subsequent calls return the same `Client` instance.
 * - Fresh after reset: `resetMcpBridgeClient()` closes the transport; the
 *   next `getMcpBridgeClient()` builds a new one.
 * - Failure mode: construction or `initialize` errors surface as a rejected
 *   Promise (never a synchronous throw), and the singleton is cleared so the
 *   caller can retry.
 */
export function getMcpBridgeClient(): Promise<Client> {
  if (pending) return pending.then((e) => e.client);

  const promise = createClient();
  pending = promise;

  // Clear the singleton on failure so the next caller can retry. We deliberately
  // keep the singleton on success — concurrent callers share it.
  promise.catch(() => {
    if (pending === promise) pending = null;
  });

  return promise.then((e) => e.client);
}

/**
 * Close the MCP bridge transport and clear the singleton.
 *
 * Wired into `api/client.ts`'s auth/workspace setters via the lifecycle
 * handler below — every `setAuthToken(...)` and `setActiveWorkspaceId(...)`
 * call drops the cached transport because the platform's `Mcp-Session-Id`
 * is workspace- and identity-bound at init. Without this, switching
 * workspaces would silently keep dispatching iframe tool calls against
 * the previous tenant's session. Safe to call when no client exists.
 */
export function resetMcpBridgeClient(): void {
  const current = pending;
  pending = null;
  if (!current) return;

  // Fire-and-forget: we don't await the close. Any awaiter of the previous
  // client that arrived after the reset can use the closed transport (it'll
  // error, they'll retry). Reset is synchronous by contract.
  current
    .then((entry) => entry.client.close())
    .catch(() => {
      // Swallow close errors — the client is going away regardless.
    });
}

// Register at module load — the side effect runs the first time anything
// in the bridge dependency graph imports this file (which is exactly when
// we'd want lifecycle resets to start firing).
setAuthLifecycleHandler(resetMcpBridgeClient);

// ---------------------------------------------------------------------------
// Session-not-found recovery
// ---------------------------------------------------------------------------

/**
 * Run an MCP bridge operation, recovering once from a stale `Mcp-Session-Id`.
 *
 * The platform's `/mcp` endpoint may respond with a 404 + JSON-RPC `Session
 * not found` envelope after a server-side TTL eviction or process restart.
 * The bridge's cached `Client` keeps replaying the dead session id on every
 * subsequent request — every iframe call would fail with that error until
 * the user refreshed the page (issue #141).
 *
 * This wrapper catches the specific shape, drops the cached singleton via
 * `resetMcpBridgeClient`, and runs `op` once more. The retried operation
 * triggers a fresh `getMcpBridgeClient()` → fresh `initialize` → fresh
 * session id, and the original request goes out clean. Other errors (real
 * tool failures, network outages, auth) propagate without modification —
 * this is recovery scoped to the single failure mode it claims to fix.
 *
 * Single retry only. If the retry also fails for any reason, the caller
 * sees that second error. Looping would mask infrastructure problems.
 *
 * Note: retry is per-operation, not per-session. A session-augmented
 * `tasks/{get,result,cancel}` against a task that lived on the lost
 * session will get a fresh session AND a fresh (empty) task table — the
 * task-id will resolve to `-32602 task not found`. That's the correct
 * answer (the task really is gone); iframes that care must re-issue any
 * in-flight work after seeing it.
 */
export async function withSessionRetry<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (!isSessionNotFoundError(err)) throw err;
    resetMcpBridgeClient();
    return await op();
  }
}

/**
 * Detect the platform's session-miss 404 across the two shapes the SDK
 * surfaces it in:
 *
 *   1. `StreamableHTTPClientTransport` sees a non-2xx response and throws
 *      a generic `Error` whose `.message` embeds the JSON-RPC envelope
 *      verbatim (`Error POSTing to endpoint: {"jsonrpc":"2.0",...}`). The
 *      substring `Session not found` reliably distinguishes us from any
 *      other JSON the transport might wrap.
 *   2. Future SDK versions may parse the JSON-RPC envelope and expose
 *      `error.data.reason` directly. Forward-compat: match `not_found`
 *      and `unavailable` (the two reasons emitted by the post-#162
 *      session-store classifier).
 *
 * Both paths return the same boolean — the recovery is identical.
 */
function isSessionNotFoundError(err: unknown): boolean {
  if (!err) return false;

  // Substring match on the SDK-wrapped transport error.
  if (err instanceof Error && err.message.includes("Session not found")) {
    return true;
  }

  // Parsed `error.data.reason` (post-#162 forward-compat).
  if (typeof err === "object" && err !== null) {
    const reason = (err as { data?: { reason?: unknown } }).data?.reason;
    if (reason === "not_found" || reason === "unavailable") return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const MCP_ENDPOINT = "/mcp";

async function createClient(): Promise<Entry> {
  // Resolve `/mcp` against the page origin. In dev, Vite proxies `/mcp`
  // to the API; in prod the web shell is served from the same origin.
  const url = new URL(MCP_ENDPOINT, globalThis.location?.origin ?? "http://localhost");

  const transport = new StreamableHTTPClientTransport(url, {
    // Custom fetch: read the auth token and workspace ID per-request. This
    // is the hook that keeps the MCP client aligned with `api/client.ts`'s
    // token refresh cycle — do NOT capture headers at transport construction
    // time, because tokens rotate.
    fetch: mcpFetch,
  });

  const client = new Client(
    {
      name: "nimblebrain-web",
      version: "1.0.0",
    },
    {
      capabilities: {
        // Advertise that this client handles `tasks/cancel`. The platform's
        // ToolTaskHandler (Task 006) only permits task augmentation when the
        // requestor declares the cancel capability.
        tasks: {
          cancel: {},
        },
      },
    },
  );

  try {
    await client.connect(transport);
  } catch (err) {
    // Best-effort cleanup; the transport may hold an aborted fetch.
    try {
      await transport.close();
    } catch {
      // Ignore — we're already unwinding.
    }
    throw err;
  }

  return { client, transport };
}

/**
 * Per-request fetch wrapper. Injects `Authorization` and `X-Workspace-Id`
 * headers on every call so token refresh is not bypassed.
 *
 * Cookie-mode (`authToken === "__cookie__"`) falls through to
 * `credentials: "include"` — the browser sends the session cookie.
 */
async function mcpFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);

  const token = getAuthToken();
  const useCookie = token === "__cookie__";
  if (token && !useCookie) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const workspaceId = getActiveWorkspaceId();
  if (workspaceId) {
    headers.set("X-Workspace-Id", workspaceId);
  }

  return fetch(input, {
    ...init,
    headers,
    // Always include credentials so cookie-mode auth works and same-origin
    // requests forward session cookies.
    credentials: init?.credentials ?? "include",
  });
}
