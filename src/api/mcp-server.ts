/**
 * MCP Server endpoint — exposes the platform as an MCP server via Streamable HTTP.
 *
 * External MCP clients (Claude Code, Open WebUI, etc.) connect to /mcp and
 * access all installed tools through the standard MCP protocol.
 *
 * **Stage 2 (cross-workspace refactor): identity-bound sessions.** The
 * `/mcp` session no longer carries a workspace. `tools/list` returns the
 * **union of every tool the identity can call** across every workspace
 * they belong to, namespaced as `ws_<id>-<tool>` via T005's aggregator.
 * `tools/call` parses the namespace via `parseNamespacedToolName` (T002)
 * and routes via `routeToolCall` (T004); the workspace is derived from
 * the parsed name on every call, NOT from any session-level state. The
 * `X-Workspace-Id` header is ignored on `/mcp` (logged once per session
 * at debug, not an error) — per Q3 the bridge keeps its session alive
 * across a workspace switch in the web shell, and the switcher must not
 * influence routing.
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
 *      touched, and which identity it's bound to. Deliberately deployment-
 *      vocabulary-free — no pod, no instance, no ownership. Routing
 *      requests to the process that owns a session's transport is the load
 *      balancer's job (cookie stickiness, header-hash), not the registry's.
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
import {
  routeToolCall,
  type ToolListAggregator,
  UnknownIdentitySource,
  UnknownNamespacedToolName,
  UnknownToolSource,
  UnknownWorkspace,
  WorkspaceAccessDenied,
} from "../orchestrator/index.ts";
import { type RequestContext, runWithRequestContext } from "../runtime/request-context.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { IDENTITY_SOURCES } from "../tools/identity-sources.ts";
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
  /** Identity bound to this session at initialize time. */
  identityId: string | null;
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
   * Runtime handle used by `tools/list` (via `getToolListAggregator`)
   * and `tools/call` (via the orchestrator's `routeToolCall`). Optional
   * for legacy unit tests that exercise only reclamation / session-miss
   * paths and never hit a tool handler; production callers always pass
   * the live runtime. When absent, `tools/list` returns an empty list and
   * `tools/call` rejects with `-32601 method not supported`.
   */
  runtime?: Runtime;
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

/**
 * Session context captured at session creation time. Stage 2 (Q4 hard
 * cut): identity-bound, not workspace-bound. Every `tools/call` parses
 * its target workspace from the namespaced tool name; the session has no
 * workspace pointer to fall back to.
 */
export interface McpSessionContext {
  identity: UserIdentity | null;
}

/**
 * Server capabilities for tasks utility (MCP draft 2025-11-25).
 *
 * - `cancel: {}` — we accept `tasks/cancel` and route through McpSource.cancelTask
 * - `requests.tools.call: {}` — we accept task-augmented `tools/call` (CreateTaskResult)
 * - `list` is deliberately absent — `tasks/list` is deferred.
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
  private readonly runtime: Runtime | null;
  private readonly idleTtlMs: number;
  private readonly maxSessions: number;
  private readonly sweepInterval: ReturnType<typeof setInterval>;
  /**
   * Tracks per-session whether we've already logged-once that the client
   * sent an `X-Workspace-Id` header. Stage 2 hard-cut sessions to identity-
   * bound, but external MCP clients (and our own bridge) will still send
   * the header for a release-cycle's worth of mixed deploys. We log once
   * at debug (under `NB_DEBUG=mcp`) per session so operators can see the
   * stragglers without spamming the log.
   */
  private readonly loggedWorkspaceHeaderSessions = new Set<string>();

  constructor(opts: McpServerHostOptions) {
    this.registry = opts.registry;
    this.runtime = opts.runtime ?? null;
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
    features: ResolvedFeatures,
    sessionCtx: McpSessionContext,
  ): Promise<Response> {
    const method = request.method;
    if (method === "POST") return this.handlePost(request, features, sessionCtx);
    if (method === "DELETE") return this.handleDelete(request, sessionCtx);
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
    this.loggedWorkspaceHeaderSessions.clear();
    await this.registry.shutdown();
  }

  /** Test-only: number of locally-held transports. */
  transportCount(): number {
    return this.transports.size;
  }

  // ─── private ──────────────────────────────────────────────────────

  private async handlePost(
    request: Request,
    features: ResolvedFeatures,
    sessionCtx: McpSessionContext,
  ): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");

    if (sessionId) {
      // Stage 2: any `X-Workspace-Id` header on this request is purely
      // advisory. Log once per session under `NB_DEBUG=mcp` so operators
      // can see clients still sending it during the cut-over window
      // without filling the log; routing always derives the workspace
      // from the namespaced tool name on every `tools/call`.
      this.maybeLogWorkspaceHeader(request, sessionId);

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
      return this.localMissResponse(request, sessionId, sessionCtx);
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
        `[mcp] non-init request without session id ${fmtSessionContext(request, null, sessionCtx)}`,
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

    return this.initializeSession(request, body, features, sessionCtx);
  }

  private async handleDelete(request: Request, sessionCtx: McpSessionContext): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");
    if (!sessionId) return new Response("Missing session ID", { status: 400 });
    const local = this.transports.get(sessionId);
    if (!local) {
      // Thread the session context so the log line carries `identity=...`
      // — exactly the cross-tenant correlation context operators need to
      // distinguish noisy clients from real eviction.
      log.info(`[mcp] delete session miss ${fmtSessionContext(request, sessionId, sessionCtx)}`);
      // Mirror the POST cleanup: registry delete is best-effort so a stale
      // entry doesn't linger after a client says "I'm done."
      this.bestEffortDelete(sessionId);
      return new Response("Session not found", { status: 404 });
    }
    return local.transport.handleRequest(request);
  }

  /**
   * Stage 2: log-once-per-session that the client sent `X-Workspace-Id`.
   * Routing post-Stage-2 derives the workspace from the namespaced tool
   * name on every `tools/call`; the header is ignored. The log line
   * surfaces the straggler so operators can chase down a stale client.
   *
   * Read once per session id to keep the cost off the hot path. The
   * `loggedWorkspaceHeaderSessions` set bloats by one entry per session
   * that ever included the header — bounded by the transport map's
   * lifetime since session id reuse is impossible (UUIDs) and the set
   * is cleared in `shutdown()`.
   */
  private maybeLogWorkspaceHeader(request: Request, sessionId: string): void {
    if (this.loggedWorkspaceHeaderSessions.has(sessionId)) return;
    const header = request.headers.get("x-workspace-id");
    if (!header) return;
    this.loggedWorkspaceHeaderSessions.add(sessionId);
    log.debug(
      "mcp",
      `ignoring X-Workspace-Id header on /mcp (sessionId=${sessionId.slice(0, 8)} value=${header}) — sessions are identity-bound; routing derives workspace from the namespaced tool name`,
    );
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
    sessionCtx: McpSessionContext,
  ): Promise<Response> {
    const meta = await this.safeRegistryGet(sessionId);
    const ctx = fmtSessionContext(request, sessionId, sessionCtx);

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
    features: ResolvedFeatures,
    sessionCtx: McpSessionContext,
  ): Promise<Response> {
    const identityId = sessionCtx.identity?.id ?? null;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid: string) => {
        const now = Date.now();

        // Stage 2: sessions are identity-bound. No workspace pointer
        // exists at session level — every `tools/call` parses the target
        // workspace from the namespaced tool name on each call. Unlike
        // pre-Stage-2 we do NOT fail-close on missing workspace context.
        this.transports.set(sid, { transport, identityId, lastAccessedAt: now });
        // Fire-and-forget the registry write. The session is already live
        // on this process; if the registry is down we still serve the client.
        this.registry
          .create({
            sessionId: sid,
            identityId,
            createdAt: now,
            lastAccessedAt: now,
          })
          .catch((err) => {
            log.warn(`[mcp] registry create failed: ${(err as Error).message}`);
          });
      },
      onsessionclosed: (sid: string) => {
        this.transports.delete(sid);
        this.loggedWorkspaceHeaderSessions.delete(sid);
        this.bestEffortDelete(sid);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        this.transports.delete(transport.sessionId);
        this.loggedWorkspaceHeaderSessions.delete(transport.sessionId);
        this.bestEffortDelete(transport.sessionId);
      }
    };

    const server = createServer(this.runtime, features, sessionCtx);
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
 * Create a new MCP Server instance bound to a single identity-scoped
 * session. Each session gets its own Server + Transport pair.
 *
 * Stage 2 (cross-workspace refactor) makes `tools/list` return the union
 * across every workspace the identity can access (via the runtime's
 * `getToolListAggregator()`), and `tools/call` parses the namespaced name
 * and routes via `routeToolCall`. Workspace is derived from the parsed
 * name on every call — never from session-level state.
 *
 * When `runtime` is null (legacy unit-test path), tool handlers degrade
 * to safe no-ops: `tools/list` returns empty and `tools/call` rejects
 * with `-32601 Method not found`.
 */
function createServer(
  runtime: Runtime | null,
  features: ResolvedFeatures,
  sessionCtx: McpSessionContext,
): Server {
  // Build a session-scoped in-memory task store. The SDK installs handlers
  // for tasks/{get,result,cancel,list} automatically when this is passed via
  // ProtocolOptions.taskStore — we never register them ourselves.
  //
  // Stage 2: the task store is identity-bound (not workspace-bound) so the
  // same session can carry tasks across multiple workspaces. The
  // `recordTask` call still stamps the per-task `ownerContext` with the
  // routed workspace so cross-tenant lookups surface as -32602
  // "task not found" per spec §8 security guidance.
  const taskStore: McpTaskStore | undefined = runtime
    ? createMcpTaskStore({
        identity: sessionCtx.identity,
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

  const identityId = sessionCtx.identity?.id ?? null;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!runtime || !identityId) {
      // Legacy unit-test path / unauthenticated dev path: no runtime
      // means no aggregator. Empty list, not an error — the SDK requires
      // a response.
      return { tools: [] };
    }
    const aggregator: ToolListAggregator = runtime.getToolListAggregator();
    const tools = await aggregator.aggregateToolList(identityId);
    const orgRole = sessionCtx.identity?.orgRole;
    return {
      tools: tools
        // Feature gating and role visibility apply to the bare (unnamespaced)
        // tool name — that's what `isToolEnabled` / `isToolVisibleToRole`
        // were built for. The aggregator carries the bare name alongside
        // the canonical `ws_<id>-<name>` form so we don't have to re-parse.
        .filter((t) => isToolEnabled(t.toolName, features))
        .filter((t) => isToolVisibleToRole(t.toolName, orgRole))
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

    if (!runtime || !identityId) {
      throw new McpError(
        ErrorCode.MethodNotFound,
        "tools/call not available on this session (runtime not wired)",
      );
    }

    // ── Stage 2: parse the namespaced tool name + route via orchestrator
    //
    // Strict invariant — no fallback to a "current workspace." A bare
    // `<source>__<tool>` name (no `ws_<id>-` prefix) parses to IDENTITY scope
    // and routes through the identity door (below); if its source isn't a
    // kernel identity source it surfaces as `-32602 Invalid params` with
    // `error.data.reason: "unknown_identity_source"`. Truly malformed names
    // (empty, empty tool, bad `ws_` id) surface as `invalid_tool_name`. Either
    // way the client gets a meaningful reason and the call never silently
    // routes. The orchestrator's five error classes
    // each map to a distinct response shape.
    let routed: Awaited<ReturnType<typeof routeToolCall>>;
    try {
      routed = await routeToolCall({
        identityId,
        namespacedName: name,
        runtime,
      });
    } catch (err) {
      if (err instanceof UnknownNamespacedToolName) {
        throw new McpError(ErrorCode.InvalidParams, `Invalid tool name: expected ws_<id>-<tool>`, {
          reason: "invalid_tool_name",
          input: err.input,
          parse: err.reason,
        });
      }
      if (err instanceof UnknownWorkspace) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown workspace "${err.wsId}"`, {
          reason: "unknown_workspace",
          wsId: err.wsId,
        });
      }
      if (err instanceof WorkspaceAccessDenied) {
        // No spec-blessed JSON-RPC code for "permission denied", but
        // `-32603 Internal error` is too broad — the call IS well-formed,
        // it just isn't allowed for this identity. The MCP draft's tasks
        // spec sets the precedent of using `-32602` for owner-mismatch
        // task lookups; we mirror that here so a misrouted call doesn't
        // get classified as a server bug. The `data.reason` field carries
        // the precise classification.
        throw new McpError(ErrorCode.InvalidParams, `Access denied to workspace "${err.wsId}"`, {
          reason: "workspace_access_denied",
          wsId: err.wsId,
        });
      }
      if (err instanceof UnknownToolSource) {
        throw new McpError(
          ErrorCode.MethodNotFound,
          `No tool source "${err.sourceName}" in workspace "${err.wsId}"`,
          {
            reason: "unknown_tool_source",
            wsId: err.wsId,
            sourceName: err.sourceName,
            toolName: err.toolName,
          },
        );
      }
      if (err instanceof UnknownIdentitySource) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `No identity source "${err.sourceName}" for "${err.toolName}"`,
          { reason: "unknown_identity_source", toolName: err.toolName },
        );
      }
      throw err;
    }

    // Identity request (bare `<source>__<tool>`): dispatch against the
    // caller's identity, no workspace. `workspaceId: null` is safe — a
    // handler that needs a workspace calls `requireWorkspaceId()`, which
    // hard-fails (never a passive failover). Identity tools (conversations)
    // aren't task-augmented, so the workspace task-negotiation below is
    // skipped; entity reads are gated by `canAccess` in the handler.
    if (routed.kind === "identity") {
      const fullName = routed.toolName;
      if (!isToolEnabled(fullName, features)) {
        return {
          content: [{ type: "text" as const, text: `Tool "${name}" is disabled` }],
          isError: true,
        };
      }
      // Role-gate at DISPATCH, not just surfacing — the workspace branch and
      // the REST handler both do, and surfacing already hides role-gated
      // identity tools, so a crafted bare `tools/call` must not slip past.
      // (No identity tool is role-gated today; this closes the gap before
      // files/automations land an admin-gated one.)
      if (!isToolVisibleToRole(fullName, sessionCtx.identity?.orgRole)) {
        return {
          content: [{ type: "text" as const, text: `Tool "${name}" is not available` }],
          isError: true,
        };
      }
      const sep = fullName.indexOf("__");
      const bare = sep >= 0 ? fullName.slice(sep + 2) : fullName;
      const identityCtx: RequestContext = {
        identity: sessionCtx.identity ?? null,
        scope: { kind: "identity" },
      };
      const idResult = await runWithRequestContext(identityCtx, () =>
        routed.source.execute(bare, (args ?? {}) as Record<string, unknown>),
      );
      return {
        content: idResult.content,
        ...(idResult.structuredContent !== undefined
          ? { structuredContent: idResult.structuredContent }
          : {}),
        isError: idResult.isError,
      };
    }

    const { context: workspaceContext, toolName: innerToolName, source } = routed;

    // Feature gating + role visibility on the BARE tool name (post-parse).
    if (!isToolEnabled(innerToolName, features)) {
      return {
        content: [{ type: "text" as const, text: `Tool "${name}" is disabled` }],
        isError: true,
      };
    }
    if (!isToolVisibleToRole(innerToolName, sessionCtx.identity?.orgRole)) {
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
    //
    // The orchestrator's parse already split `innerToolName` into
    // `<source>__<tool>`; reuse that here.
    const sepIndex = innerToolName.indexOf("__");
    const sourceName = sepIndex >= 0 ? innerToolName.slice(0, sepIndex) : null;
    const localName = sepIndex >= 0 ? innerToolName.slice(sepIndex + 2) : innerToolName;
    const wsId = workspaceContext.workspaceId;
    const wsRegistry = runtime.getRegistryForWorkspace(wsId);
    const taskAwareSource = sourceName ? wsRegistry.findTaskAwareSource(sourceName) : null;
    // Inspect the cached tool definition (if the source is MCP-backed) to
    // read `taskSupport`. Non-MCP sources never support tasks.
    let taskSupport: "optional" | "required" | "forbidden" | undefined;
    if (taskAwareSource) {
      const tools = await taskAwareSource.tools();
      const tool = tools.find((t) => t.name === innerToolName);
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

    // Build per-request context for AsyncLocalStorage (concurrency-safe).
    // Workspace ID is derived from the parsed namespace — NOT from any
    // session-level state. This is the per-call routing the orchestrator
    // exists to enforce.
    const reqCtx: RequestContext = {
      identity: sessionCtx.identity ?? null,
      scope: {
        kind: "workspace",
        workspaceId: wsId,
        workspaceAgents: null,
        workspaceModelOverride: null,
      },
    };

    // ── Task-augmented path ─────────────────────────────────────────────
    //
    // Return a CreateTaskResult immediately. The McpSource has already
    // started the stream and is draining it in the background; its
    // TaskHandle holds the terminal deferred for later `tasks/result` and
    // its abortController for `tasks/cancel`. We stash the (source, owner)
    // pair in the session's task store so the SDK-installed task handlers
    // can find their way back.
    if (isTaskRequest && taskAwareSource && taskStore) {
      const ownerContext: OwnerContext = {
        workspaceId: wsId,
        ...(sessionCtx.identity?.id ? { identityId: sessionCtx.identity.id } : {}),
      };
      const createResult: CreateTaskResult = await runWithRequestContext(reqCtx, () =>
        taskAwareSource.startToolAsTask(localName, (args ?? {}) as Record<string, unknown>, {
          ownerContext,
          ...(taskParam.ttl !== undefined ? { ttlMs: taskParam.ttl } : {}),
        }),
      );
      taskStore.recordTask({
        source: taskAwareSource as TaskAwareSource,
        toolFullName: innerToolName,
        task: createResult.task,
        ownerContext,
      });
      return createResult;
    }

    // ── Inline path ─────────────────────────────────────────────────────
    //
    // Dispatch via the resolved source directly (the orchestrator already
    // looked it up and returned it). `ToolSource.execute` takes the bare
    // (post-`__`) tool name, mirroring `ToolRegistry.execute`'s contract.
    //
    // Preserve `structuredContent` — dropping it was a long-standing bug
    // that silently violated `CallToolResult must be returned as-is`.
    // `_meta` propagation on the
    // inline path is a no-op today because the engine's ToolResult shape
    // doesn't carry `_meta`; task-augmented flows carry `_meta` through
    // naturally because `tasks/result` returns the full CallToolResult
    // directly from `awaitToolTaskResult` (see mcp-task-store.ts).
    const result = await runWithRequestContext(reqCtx, () =>
      source.execute(localName, (args ?? {}) as Record<string, unknown>),
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
  // Stage 2: aggregate resources across every workspace the identity can
  // access. Each per-workspace iteration mirrors the pre-Stage-2 logic
  // (delegate to the underlying MCP client; swallow per-source errors so
  // one bad source doesn't kill the listing). One stuck workspace's
  // registry must not poison the cross-workspace list either.
  //
  // Pagination: MVP returns everything in a single response (no `cursor`
  // plumbing). The SDK type allows `nextCursor`, but iframe consumers today
  // enumerate the full list. Document here so we remember to add cursor
  // support if/when resource counts grow beyond a few hundred per workspace.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Resource[] = [];
    if (!runtime || !identityId) return { resources };

    const wsStore = runtime.getWorkspaceStore();
    let accessible: Array<{ id: string }>;
    try {
      accessible = await wsStore.getWorkspacesForUser(identityId);
    } catch {
      return { resources };
    }
    for (const ws of accessible) {
      let wsRegistry: ToolRegistry;
      try {
        wsRegistry = await runtime.ensureWorkspaceRegistry(ws.id);
      } catch {
        continue;
      }
      for (const src of wsRegistry.getSources()) {
        if (!(src instanceof McpSource)) continue;
        const client = src.getClient();
        if (!client) continue;
        try {
          const result = await client.listResources();
          for (const r of result.resources) {
            resources.push(r as Resource);
          }
        } catch {
          // Source didn't implement resources/list, or transport hiccup.
          // Swallow per-source errors so one bad source doesn't kill the
          // cross-workspace list.
        }
      }
    }
    return { resources };
  });

  // ── resources/read ────────────────────────────────────────────────
  //
  // Stage 2: search across every workspace the identity can access.
  // Cross-workspace lookups: we deliberately do not distinguish
  // "doesn't exist anywhere" from "exists but you can't see it" — per
  // MCP spec guidance, avoid leaking cross-tenant existence information.
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (!runtime || !identityId) {
      throw new McpError(RESOURCE_NOT_FOUND_CODE, `Resource not found: ${uri}`, { uri });
    }

    // Identity sources (files, conversations, automations) are owned by the
    // user and live OUTSIDE every workspace registry, so the workspace sweep
    // below can't see them — `files://<id>` would never resolve. Try them
    // first, within the identity request context so the source reads the
    // caller's own data (the files source resolves its store via
    // `getCurrentIdentity()`, mirroring the identity-door tools/call path).
    const identityReqCtx: RequestContext = {
      identity: sessionCtx.identity ?? null,
      scope: { kind: "identity" },
    };
    for (const sourceName of IDENTITY_SOURCES) {
      const src = runtime.getIdentitySource(sourceName);
      if (!(src instanceof McpSource)) continue;
      const client = src.getClient();
      if (!client) continue;
      try {
        const result = await runWithRequestContext(identityReqCtx, () =>
          client.readResource({ uri }),
        );
        if (result.contents && result.contents.length > 0) {
          return result;
        }
      } catch {
        // Not this source, or not found here — fall through to the next
        // identity source and ultimately the workspace sweep.
      }
    }

    const wsStore = runtime.getWorkspaceStore();
    const accessible = await wsStore.getWorkspacesForUser(identityId);
    for (const ws of accessible) {
      let wsRegistry: ToolRegistry;
      try {
        wsRegistry = await runtime.ensureWorkspaceRegistry(ws.id);
      } catch {
        continue;
      }
      for (const src of wsRegistry.getSources()) {
        if (src instanceof McpSource) {
          const client = src.getClient();
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
    }

    // No source in any accessible workspace resolved the URI. Per MCP
    // spec, raise a JSON-RPC error — the SDK transport converts McpError
    // into a proper `error` envelope.
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
 * prefix keeps lines greppable), identity (for cross-tenant correlation), and
 * the client IP from `x-forwarded-for` (the ALB sets it).
 *
 * Stage 2: the workspace key is gone — sessions are identity-bound and
 * carry no workspace pointer. Routing context (the parsed workspace) is
 * stamped on per-tool-call log lines, not session-level diagnostics.
 */
function fmtSessionContext(
  request: Request,
  sessionId: string | null,
  sessionCtx?: McpSessionContext,
): string {
  const sidPrefix = sessionId ? sessionId.slice(0, 8) : "none";
  const identityId = sessionCtx?.identity?.id ?? "none";
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "direct";
  return `sessionId=${sidPrefix} identity=${identityId} ip=${ip}`;
}
