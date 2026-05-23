/**
 * MCP Server endpoint — exposes the platform as an MCP server via Streamable HTTP.
 *
 * External MCP clients (Claude Code, Open WebUI, etc.) connect to /mcp and
 * access all installed tools through the standard MCP protocol.
 *
 * Two-layer state architecture:
 *
 *   1. **Transport map** (per-process, in-memory, never abstracted) — owns
 *      the live `WebStandardStreamableHTTPServerTransport`, the SDK `Server`
 *      instance with its registered handlers, and any in-flight JSON-RPC
 *      state. Process-bound: holds open response streams and JS object
 *      references that cannot be serialized or moved.
 *
 *   2. **SessionRegistry** (pluggable; see `./session-store/`) — cluster-
 *      shared metadata. Tells us whether a session exists, when it was last
 *      touched, and which workspace + identity it's bound to. Deliberately
 *      deployment-vocabulary-free — no pod, no instance, no ownership.
 *      Routing requests to the process that owns a session's transport is
 *      the load balancer's job (cookie stickiness, header-hash), not the
 *      registry's.
 *
 * Reclamation policy on the transport map (the layer that holds the heap):
 *
 *   - **Idle TTL** — a periodic sweep closes any transport whose
 *     `lastAccessedAt` is older than the configured idle TTL. Same TTL the
 *     registry uses; one knob (`MCP_SESSION_TTL_SECONDS`). This releases
 *     orphaned transports from clients that vanish without sending DELETE
 *     (mobile backgrounding, closed tabs, abandoned OAuth flows). The
 *     registry's own TTL becomes redundant safety on the metadata layer.
 *
 *   - **LRU on capacity** — the map is ordered most-recently-used last.
 *     When a new initialize arrives at capacity, the least-recently-used
 *     transport is closed and replaced. Capacity overflow is **not** a
 *     client error; well-formed initializes always succeed. The cap
 *     (`MCP_MAX_SESSIONS`) is a memory-budget device, not a feature gate.
 *
 * Both reclamation paths funnel through `evict(sid, reason)`, which removes
 * the entry from the map *before* calling `close()` — preventing a
 * concurrent request from finding a half-dead transport between the close
 * call and the SDK's `onclose` cascade.
 *
 * On a request whose sessionId we don't have a local transport for:
 *
 *   - Registry says nothing exists → `not_found`. Session evicted or never
 *     created.
 *   - Registry says it exists      → `unavailable`. The live transport isn't
 *     on this process. Could be: process restart, sticky-routing miss,
 *     local transport closed, anything. Client's correct action is the
 *     same in either case: re-initialize.
 *
 * Both return 404 with a JSON-RPC envelope; `error.data.reason` lets
 * operators correlate logs without the registry having to know what an
 * "instance" is. During eviction there is a small window where the local
 * map has already removed the entry but the registry-side delete has not
 * yet landed — in that window the response carries `reason: "unavailable"`
 * instead of `"not_found"`. Not a bug; operators should be aware.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  type CreateTaskResult,
  ErrorCode,
  isInitializeRequest,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Resource,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { log } from "../cli/log.ts";
import { isToolEnabled, isToolVisibleToRole, type ResolvedFeatures } from "../config/features.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { type RequestContext, runWithRequestContext } from "../runtime/request-context.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import {
  createMcpTaskStore,
  type McpTaskStore,
  type OwnerContext,
  type TaskAwareSource,
} from "./mcp-task-store.ts";
import type { SessionRegistry } from "./session-store/index.ts";

/**
 * JSON-RPC error code for "resource not found".
 *
 * MCP specifies this code for `resources/read` when the URI can't be resolved.
 * It's not part of the base JSON-RPC 2.0 set nor the SDK's `ErrorCode` enum
 * (which only covers JSON-RPC's reserved range), so we declare it here.
 */
const RESOURCE_NOT_FOUND_CODE = -32002;

const mcpPkgPath = resolve(import.meta.dirname ?? __dirname, "../../package.json");
const mcpPkg = JSON.parse(readFileSync(mcpPkgPath, "utf-8")) as {
  version: string;
};
// Prefer the build-time-injected git tag; fall back to package.json for local dev.
const MCP_SERVER_VERSION = process.env.NB_VERSION || mcpPkg.version;

/* ── Capacity limit (configurable via env) ──
 *
 * The cap is a memory ceiling on the local transport map. When a new
 * initialize lands at capacity, the least-recently-used transport is
 * evicted to make room — we never refuse a well-formed initialize.
 * Override via `MCP_MAX_SESSIONS`.
 *
 * Idle reclamation is independent: a periodic sweep closes transports
 * whose `lastAccessedAt` is past the idle TTL. Same TTL knob the
 * registry uses (`MCP_SESSION_TTL_SECONDS` / `sessionStore.ttlSeconds`),
 * applied in `Runtime.getSessionStoreTtlMs()` and threaded into the
 * host. Under normal load the cap should never bind; LRU is the safety
 * valve, idle TTL is the primary release path.
 */
const MAX_MCP_SESSIONS = parsePositiveIntEnv("MCP_MAX_SESSIONS", 100);

/** Sweep cadence for the idle reclamation loop. Matches the in-memory registry. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/**
 * Validate a positive-integer env var. Rejects NaN / non-positive values
 * (e.g. `8h` typo) and falls back loudly so silent eviction-disabled state
 * can't ship to prod undetected.
 *
 * Exported for unit testing.
 */
export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    log.warn(`[mcp] ignoring invalid ${name}="${raw}" (not a positive integer); using ${fallback}`);
    return fallback;
  }
  return parsed;
}

interface TransportEntry {
  transport: WebStandardStreamableHTTPServerTransport;
  workspaceId: string;
  /**
   * Wall-clock ms of the last request that touched this transport. Drives
   * both idle eviction (sweep closes entries older than `idleTtlMs`) and
   * LRU ordering (the Map is mutated on each touch so iteration order is
   * least-recently-used first).
   */
  lastAccessedAt: number;
}

export interface McpServerHostOptions {
  registry: SessionRegistry;
  /**
   * Idle TTL in ms. Transports with no activity past this window are
   * evicted by the periodic sweep. Required: there is no sensible default
   * that wouldn't silently disable eviction on misconfiguration.
   */
  idleTtlMs: number;
  /** Soft cap on concurrent transports. Overflow evicts least-recently-used. */
  maxSessions?: number;
  /**
   * Sweep cadence in ms. Internal knob; production uses
   * `DEFAULT_SWEEP_INTERVAL_MS`. Tests override to advance faster than
   * wall-clock so short-TTL assertions don't take seconds.
   */
  sweepIntervalMs?: number;
}

/** Workspace context captured at session creation time. */
export interface McpWorkspaceContext {
  /** Pre-scoped workspace registry (already filtered to workspace-accessible sources). */
  registry: ToolRegistry;
  identity: UserIdentity | null;
  workspaceId: string | null;
}

/**
 * Server capabilities for tasks utility (MCP draft 2025-11-25).
 *
 * - `cancel: {}` — we accept `tasks/cancel` and route through McpSource.cancelTask
 * - `requests.tools.call: {}` — we accept task-augmented `tools/call` (CreateTaskResult)
 * - `list` is deliberately absent — `tasks/list` is deferred (see SPEC_REFERENCE §Deferred).
 *
 * Shape defined by `ServerCapabilitiesSchema.tasks` in the SDK types.
 */
const TASKS_CAPABILITY: NonNullable<ServerCapabilities["tasks"]> = {
  cancel: {},
  requests: { tools: { call: {} } },
};

/**
 * Per-process MCP HTTP host. Owns the in-process transport map and delegates
 * cluster-shared session metadata to the injected `SessionRegistry`.
 *
 * One instance per process. Constructed in `startServer`, threaded through
 * `AppContext`, used by `routes/mcp.ts`.
 */
export class McpServerHost {
  private readonly transports = new Map<string, TransportEntry>();
  private readonly registry: SessionRegistry;
  private readonly idleTtlMs: number;
  private readonly maxSessions: number;
  private readonly sweepInterval: ReturnType<typeof setInterval>;

  constructor(opts: McpServerHostOptions) {
    this.registry = opts.registry;
    this.idleTtlMs = opts.idleTtlMs;
    this.maxSessions = opts.maxSessions ?? MAX_MCP_SESSIONS;

    // Validate up-front: silent eviction-disabled state must not ship to
    // prod. Mirrors the philosophy of `parsePositiveIntEnv` for the env path.
    if (!Number.isFinite(this.idleTtlMs) || this.idleTtlMs <= 0) {
      throw new Error(`McpServerHost: idleTtlMs must be a positive number, got ${this.idleTtlMs}`);
    }
    if (
      !Number.isFinite(this.maxSessions) ||
      this.maxSessions <= 0 ||
      !Number.isInteger(this.maxSessions)
    ) {
      throw new Error(
        `McpServerHost: maxSessions must be a positive integer, got ${this.maxSessions}`,
      );
    }

    const intervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.sweepInterval = setInterval(() => this.sweepIdle(Date.now()), intervalMs);
    if (typeof this.sweepInterval === "object" && "unref" in this.sweepInterval) {
      this.sweepInterval.unref();
    }
  }

  /**
   * Handle an incoming HTTP request on the /mcp path.
   *
   * - POST: JSON-RPC messages (initialization or subsequent)
   * - GET:  405 — see comment below
   * - DELETE: Session termination
   *
   * GET /mcp is the spec's *optional* server→client SSE channel for
   * notifications outside any in-flight request (broadcast notifications,
   * sampling, elicitation). We don't push anything down it: tool responses
   * and task progress flow on the POST that started them, and our own
   * server→client signaling for the iframe app (data.changed, conversation
   * events, heartbeats) goes through `/v1/events`, not MCP.
   *
   * Holding the connection open with nothing to write meant Bun's
   * `idleTimeout` (max 255s) — and any L7 proxy in front of the API (Vite
   * dev proxy, ALB's 60s default, nginx) — would silently kill the socket,
   * surfacing as `socket hang up` upstream and triggering the SDK's
   * limited reconnect loop (default `maxRetries: 2`).
   *
   * Returning 405 is the spec-blessed escape hatch: the SDK explicitly
   * treats it as "server doesn't offer GET-style listening" and gracefully
   * runs POST-only (`@modelcontextprotocol/sdk/.../client/streamableHttp.js`
   * in `_startOrAuthSse`). If we ever start emitting standalone-stream
   * notifications, switch this back to a real handler and add a heartbeat
   * (see `src/api/sse-heartbeat.ts`).
   */
  async handle(
    request: Request,
    toolRegistry: ToolRegistry,
    features: ResolvedFeatures,
    workspaceCtx?: McpWorkspaceContext,
  ): Promise<Response> {
    const method = request.method;
    if (method === "POST") return this.handlePost(request, toolRegistry, features, workspaceCtx);
    if (method === "DELETE") return this.handleDelete(request, workspaceCtx);
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST, DELETE" },
    });
  }

  /**
   * Close every transport this pod owns and shut the registry down. Called
   * during graceful server stop.
   */
  async shutdown(): Promise<void> {
    clearInterval(this.sweepInterval);
    for (const [sid, entry] of this.transports) {
      try {
        await entry.transport.close();
      } catch {
        // Ignore close errors during shutdown
      }
      this.transports.delete(sid);
    }
    await this.registry.shutdown();
  }

  /** Test-only: number of locally-held transports. */
  transportCount(): number {
    return this.transports.size;
  }

  // ─── private ──────────────────────────────────────────────────────

  private async handlePost(
    request: Request,
    toolRegistry: ToolRegistry,
    features: ResolvedFeatures,
    workspaceCtx?: McpWorkspaceContext,
  ): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");

    if (sessionId) {
      const local = this.transports.get(sessionId);
      if (local) {
        // Fast path: we own this transport. Touch + re-insert moves the
        // entry to the MRU end of the Map so LRU eviction picks the oldest
        // first. Best-effort registry touch keeps the cluster-shared TTL
        // aligned without blocking the request.
        const now = Date.now();
        local.lastAccessedAt = now;
        this.transports.delete(sessionId);
        this.transports.set(sessionId, local);
        this.registry.touch(sessionId, now).catch((err) => {
          log.warn(`[mcp] registry touch failed: ${(err as Error).message}`);
        });
        return local.transport.handleRequest(request);
      }
      return this.localMissResponse(request, sessionId, workspaceCtx);
    }

    // No session id — must be an initialize.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonRpcError(400, -32700, "Parse error");
    }

    if (!isInitializeRequest(body)) {
      log.warn(
        `[mcp] non-init request without session id ${fmtSessionContext(request, null, workspaceCtx)}`,
      );
      return jsonRpcError(400, -32000, "Bad Request: No valid session ID provided");
    }

    // At capacity, evict the least-recently-used transport (front of the
    // Map iteration order) before admitting the new initialize. Well-formed
    // initializes always succeed; the cap is a memory budget, not a 4xx.
    while (this.transports.size >= this.maxSessions) {
      const oldest = this.transports.keys().next();
      if (oldest.done) break;
      this.evict(oldest.value, "pressure");
    }

    return this.initializeSession(request, body, toolRegistry, features, workspaceCtx);
  }

  private async handleDelete(
    request: Request,
    workspaceCtx?: McpWorkspaceContext,
  ): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");
    if (!sessionId) return new Response("Missing session ID", { status: 400 });
    const local = this.transports.get(sessionId);
    if (!local) {
      // Thread the workspace context so the log line carries `workspace=...`
      // and `identity=...` — exactly the cross-tenant correlation context
      // operators need to distinguish noisy clients from real eviction.
      log.info(`[mcp] delete session miss ${fmtSessionContext(request, sessionId, workspaceCtx)}`);
      // Mirror the POST cleanup: registry delete is best-effort so a stale
      // entry doesn't linger after a client says "I'm done."
      this.bestEffortDelete(sessionId);
      return new Response("Session not found", { status: 404 });
    }
    return local.transport.handleRequest(request);
  }

  /**
   * Build the 404 response when the local transport map doesn't contain the
   * requested session ID. The `error.data.reason` distinguishes:
   *
   *   - `not_found` — the registry has no entry. Session evicted by TTL,
   *     never existed, or already deleted.
   *   - `unavailable` — the registry has an entry, but the live transport
   *     isn't on this process. Could be a process restart (transport state
   *     was lost) or a sticky-routing miss (the request landed on a process
   *     that didn't initialize this session). Client should re-initialize
   *     either way; operators distinguish via deploy timing, uptime, and
   *     "registry size vs local transport count" signals.
   */
  private async localMissResponse(
    request: Request,
    sessionId: string,
    workspaceCtx?: McpWorkspaceContext,
  ): Promise<Response> {
    const meta = await this.safeRegistryGet(sessionId);
    const ctx = fmtSessionContext(request, sessionId, workspaceCtx);

    const reason: "not_found" | "unavailable" = meta ? "unavailable" : "not_found";
    log.warn(`[mcp] session miss reason=${reason} ${ctx}`);

    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Session not found", data: { reason } },
        id: null,
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  /**
   * Wrap `registry.get` so a registry outage degrades to "treat as missing"
   * rather than killing the request. The local transport map already
   * answered "I don't have it"; the worst case here is we report `not_found`
   * instead of a more specific reason — still a useful 404.
   */
  private async safeRegistryGet(
    sessionId: string,
  ): Promise<Awaited<ReturnType<SessionRegistry["get"]>>> {
    try {
      return await this.registry.get(sessionId);
    } catch (err) {
      log.warn(`[mcp] registry get failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async initializeSession(
    request: Request,
    parsedBody: unknown,
    toolRegistry: ToolRegistry,
    features: ResolvedFeatures,
    workspaceCtx: McpWorkspaceContext | undefined,
  ): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid: string) => {
        const now = Date.now();
        const wsId = workspaceCtx?.workspaceId;
        if (!wsId) {
          // Should never happen — `routes/mcp.ts` enforces workspace
          // resolution before reaching the host. Fail loudly so a future
          // refactor can't slip past this guarantee silently.
          log.warn("[mcp] session init reached host without workspaceId — closing transport");
          transport.close().catch(() => {});
          return;
        }

        this.transports.set(sid, { transport, workspaceId: wsId, lastAccessedAt: now });
        // Fire-and-forget the registry write. The session is already live
        // on this process; if the registry is down we still serve the client.
        this.registry
          .create({
            sessionId: sid,
            identityId: workspaceCtx?.identity?.id ?? null,
            workspaceId: wsId,
            createdAt: now,
            lastAccessedAt: now,
          })
          .catch((err) => {
            log.warn(`[mcp] registry create failed: ${(err as Error).message}`);
          });
      },
      onsessionclosed: (sid: string) => {
        this.transports.delete(sid);
        this.bestEffortDelete(sid);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        this.transports.delete(transport.sessionId);
        this.bestEffortDelete(transport.sessionId);
      }
    };

    const server = createServer(toolRegistry, features, workspaceCtx);
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody });
  }

  /**
   * Close a transport and remove it from the lookup map. Used by both
   * reclamation paths (`sweepIdle` and capacity-pressure eviction in
   * `handlePost`).
   *
   * Order matters: remove from `this.transports` BEFORE calling `close()`.
   * The SDK's `close()` fires `transport.onclose` synchronously inside its
   * body, which would run the existing cleanup cascade (map delete +
   * registry delete) — but during the window between the close call and
   * onclose firing, a concurrent request to the fast path could still see
   * the entry and dispatch into a half-dead transport. Deleting first
   * closes that window. The cascade's second `transports.delete(sid)` then
   * becomes an idempotent no-op.
   *
   * Registry cleanup is delegated to the existing `transport.onclose`
   * handler so we don't double-call `bestEffortDelete` from both paths.
   */
  private evict(sessionId: string, reason: "idle" | "pressure"): void {
    const entry = this.transports.get(sessionId);
    if (!entry) return;
    const idleMs = Date.now() - entry.lastAccessedAt;
    log.info(`[mcp] evicting transport reason=${reason} sessionId=${sessionId} idleMs=${idleMs}`);
    this.transports.delete(sessionId);
    entry.transport.close().catch((err) => {
      log.warn(`[mcp] evict close failed sessionId=${sessionId}: ${(err as Error).message}`);
    });
  }

  /**
   * Walk the transport map oldest-first and evict any entry whose idle
   * window has elapsed. Map iteration order is LRU order (we re-insert on
   * touch), so we can stop at the first entry that's still within TTL —
   * everything after it is newer.
   */
  private sweepIdle(now: number): void {
    for (const [sid, entry] of this.transports) {
      if (now - entry.lastAccessedAt <= this.idleTtlMs) break;
      this.evict(sid, "idle");
    }
  }

  /**
   * Best-effort registry delete on session teardown. Failures are not fatal
   * (the local transport is already gone; the registry entry will TTL out)
   * but we log them so a chronically-failing Redis surfaces in the same
   * observability stream as `session miss` warnings rather than vanishing
   * into a silent `.catch`.
   */
  private bestEffortDelete(sessionId: string): void {
    this.registry.delete(sessionId).catch((err) => {
      log.warn(`[mcp] registry delete failed: ${(err as Error).message}`);
    });
  }
}

/**
 * Create a new MCP Server instance wired to the given ToolRegistry.
 * Each session gets its own Server + Transport pair.
 *
 * When workspaceCtx is provided, the pre-scoped workspace registry is used
 * (already filtered to workspace-accessible sources) and identity is
 * set/cleared around each tool execution.
 */
function createServer(
  registry: ToolRegistry,
  features: ResolvedFeatures,
  workspaceCtx?: McpWorkspaceContext,
): Server {
  // Workspace context is required — every request must be workspace-scoped
  const activeRegistry = workspaceCtx?.registry ?? registry; // registry is always workspace-scoped now

  // Build a session-scoped in-memory task store. The SDK installs handlers
  // for tasks/{get,result,cancel,list} automatically when this is passed via
  // ProtocolOptions.taskStore — we never register them ourselves. The store
  // binds every task to (workspaceId, identityId) so cross-tenant lookups
  // surface as -32602 "task not found" per spec §8 security guidance.
  //
  // Tasks require a workspace for authorization binding. If no workspace was
  // resolved (unauthenticated dev path), the capability isn't advertised and
  // the endpoint behaves as if tasks were disabled.
  const taskStore: McpTaskStore | undefined = workspaceCtx?.workspaceId
    ? createMcpTaskStore({
        identity: workspaceCtx.identity,
        workspaceId: workspaceCtx.workspaceId,
      })
    : undefined;

  const server = new Server(
    { name: "nimblebrain", version: MCP_SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        ...(taskStore ? { tasks: TASKS_CAPABILITY } : {}),
      },
      ...(taskStore ? { taskStore } : {}),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await activeRegistry.availableTools();
    const orgRole = workspaceCtx?.identity?.orgRole;
    return {
      tools: tools
        .filter((t) => isToolEnabled(t.name, features))
        .filter((t) => isToolVisibleToRole(t.name, orgRole))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as {
            type: "object";
            properties?: Record<string, unknown>;
            required?: string[];
          },
        })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const taskParam = request.params.task; // { ttl?, pollInterval? } | undefined
    const isTaskRequest = taskParam !== undefined;

    if (!isToolEnabled(name, features)) {
      return {
        content: [{ type: "text" as const, text: `Tool "${name}" is disabled` }],
        isError: true,
      };
    }
    if (!isToolVisibleToRole(name, workspaceCtx?.identity?.orgRole)) {
      return {
        content: [{ type: "text" as const, text: `Tool "${name}" is not available` }],
        isError: true,
      };
    }

    // ── Tool-level task negotiation (MCP spec 2025-11-25 §tasks) ─────────
    //
    // The low-level SDK `Server` validates the *result shape* against the
    // request (CreateTaskResult vs CallToolResult) but does NOT enforce the
    // tool-level taskSupport semantics. We do that here:
    //   - `required` + no task param   → -32601 MethodNotFound
    //   - `forbidden`/absent + task    → -32601 MethodNotFound
    //   - `optional`                   → either path is legal
    //
    // See `src/tools/types.ts::Tool.execution.taskSupport` for the field.
    const sepIndex = name.indexOf("__");
    const sourceName = sepIndex >= 0 ? name.slice(0, sepIndex) : null;
    const localName = sepIndex >= 0 ? name.slice(sepIndex + 2) : name;
    const taskAwareSource = sourceName ? activeRegistry.findTaskAwareSource(sourceName) : null;
    // Inspect the cached tool definition (if the source is MCP-backed) to
    // read `taskSupport`. Non-MCP sources never support tasks.
    let taskSupport: "optional" | "required" | "forbidden" | undefined;
    if (taskAwareSource) {
      const tools = await taskAwareSource.tools();
      const tool = tools.find((t) => t.name === name);
      taskSupport = tool?.execution?.taskSupport;
    }

    if (taskSupport === "required" && !isTaskRequest) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Tool ${name} requires task augmentation (taskSupport: 'required')`,
      );
    }
    if (isTaskRequest && (!taskSupport || taskSupport === "forbidden")) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Tool ${name} does not support task augmentation (taskSupport: ${taskSupport ?? "none"})`,
      );
    }

    // Build per-request context for AsyncLocalStorage (concurrency-safe)
    const reqCtx: RequestContext = {
      identity: workspaceCtx?.identity ?? null,
      workspaceId: workspaceCtx?.workspaceId ?? null,
      workspaceAgents: null,
      workspaceModelOverride: null,
    };

    // ── Task-augmented path ─────────────────────────────────────────────
    //
    // Return a CreateTaskResult immediately. The McpSource has already
    // started the stream and is draining it in the background; its
    // TaskHandle holds the terminal deferred for later `tasks/result` and
    // its abortController for `tasks/cancel`. We stash the (source, owner)
    // pair in the session's task store so the SDK-installed task handlers
    // can find their way back.
    if (isTaskRequest && taskAwareSource && taskStore && workspaceCtx?.workspaceId) {
      const ownerContext: OwnerContext = {
        workspaceId: workspaceCtx.workspaceId,
        ...(workspaceCtx.identity?.id ? { identityId: workspaceCtx.identity.id } : {}),
      };
      const createResult: CreateTaskResult = await runWithRequestContext(reqCtx, () =>
        taskAwareSource.startToolAsTask(localName, (args ?? {}) as Record<string, unknown>, {
          ownerContext,
          ...(taskParam.ttl !== undefined ? { ttlMs: taskParam.ttl } : {}),
        }),
      );
      taskStore.recordTask({
        source: taskAwareSource as unknown as TaskAwareSource,
        toolFullName: name,
        task: createResult.task,
        ownerContext,
      });
      return createResult;
    }

    // ── Inline path ─────────────────────────────────────────────────────
    //
    // Preserve `structuredContent` — dropping it was a long-standing bug
    // that silently violated `CallToolResult must be returned as-is`
    // (SPEC_REFERENCE §Non-Negotiable Rule 4). `_meta` propagation on the
    // inline path is a no-op today because the engine's ToolResult shape
    // doesn't carry `_meta`; task-augmented flows carry `_meta` through
    // naturally because `tasks/result` returns the full CallToolResult
    // directly from `awaitToolTaskResult` (see mcp-task-store.ts).
    const result = await runWithRequestContext(reqCtx, () =>
      activeRegistry.execute({
        id: crypto.randomUUID(),
        name,
        input: (args ?? {}) as Record<string, unknown>,
      }),
    );
    return {
      content: result.content,
      ...(result.structuredContent !== undefined
        ? { structuredContent: result.structuredContent }
        : {}),
      isError: result.isError,
    };
  });

  // ── resources/list ────────────────────────────────────────────────
  //
  // Aggregate resources from every source in the workspace registry.
  //
  // Delegates to each source's underlying MCP client (via `McpSource`) so we
  // don't duplicate the server-side resource metadata. Sources that don't
  // expose resources (e.g. plain `InlineSource` without async reads) are
  // skipped. Sources that throw on `listResources` are skipped too — one
  // broken bundle must not take down the workspace-wide listing.
  //
  // Pagination: MVP returns everything in a single response (no `cursor`
  // plumbing). The SDK type allows `nextCursor`, but iframe consumers today
  // enumerate the full list. Document here so we remember to add cursor
  // support if/when resource counts grow beyond a few hundred per workspace.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Resource[] = [];
    for (const source of activeRegistry.getSources()) {
      if (!(source instanceof McpSource)) continue;
      const client = source.getClient();
      if (!client) continue;
      try {
        const result = await client.listResources();
        for (const r of result.resources) {
          resources.push(r as Resource);
        }
      } catch {
        // Source didn't implement resources/list, or transport hiccup.
        // Swallow per-source errors so one bad source doesn't kill the list.
      }
    }
    return { resources };
  });

  // ── resources/read ────────────────────────────────────────────────
  //
  // Iterate workspace-scoped sources and return the first `ReadResourceResult`
  // that resolves. Mirrors the `nb__read_resource` tool's dispatch loop, but
  // returns the full MCP `contents[]` shape (including `blob` for binaries)
  // rather than flattening to text.
  //
  // Cross-workspace lookups: because we only iterate `activeRegistry`
  // (already scoped via `ensureWorkspaceRegistry`), a URI owned by a source
  // that lives in a different workspace simply isn't found and returns
  // `-32002`. We deliberately do not distinguish "doesn't exist anywhere"
  // from "exists but you can't see it" — per MCP spec guidance, avoid
  // leaking cross-tenant existence information.
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    for (const source of activeRegistry.getSources()) {
      // Prefer the MCP client path — returns the raw `ReadResourceResult`
      // (including binary `blob` payloads) as-is so callers get spec shape.
      if (source instanceof McpSource) {
        const client = source.getClient();
        if (!client) continue;
        try {
          const result = await client.readResource({ uri });
          if (result.contents && result.contents.length > 0) {
            return result;
          }
        } catch {
          // Resource not found on this source; keep trying the next one.
        }
      }
    }

    // No source resolved the URI. Per MCP spec, raise a JSON-RPC error —
    // the SDK transport converts McpError into a proper `error` envelope.
    throw new McpError(RESOURCE_NOT_FOUND_CODE, `Resource not found: ${uri}`, { uri });
  });

  return server;
}

/** JSON-RPC error response with the proper headers. */
function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Build a `key=value` log fragment with the request context that matters for
 * session-miss diagnosis: a sessionId prefix (UUIDs are not sensitive but the
 * prefix keeps lines greppable), workspace + identity (for cross-tenant
 * correlation), and the client IP from `x-forwarded-for` (the ALB sets it).
 */
function fmtSessionContext(
  request: Request,
  sessionId: string | null,
  workspaceCtx?: McpWorkspaceContext,
): string {
  const sidPrefix = sessionId ? sessionId.slice(0, 8) : "none";
  const wsId = workspaceCtx?.workspaceId ?? "none";
  const identityId = workspaceCtx?.identity?.id ?? "none";
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "direct";
  return `sessionId=${sidPrefix} workspace=${wsId} identity=${identityId} ip=${ip}`;
}
