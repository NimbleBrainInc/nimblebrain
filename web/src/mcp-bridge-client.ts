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
