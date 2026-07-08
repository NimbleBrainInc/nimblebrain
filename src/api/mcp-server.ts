/**
 * MCP Server endpoint — exposes the platform as an MCP server via Streamable HTTP.
 *
 * External MCP clients (Claude Code, Open WebUI, etc.) connect to /mcp and
 * access all installed tools through the standard MCP protocol.
 *
 * **Identity-bound sessions, walled to a per-request workspace.** A `/mcp`
 * session has no fixed workspace; each request names its focused workspace via
 * the `X-Workspace-Id` header (the web iframe bridge sends it on every call).
 * The host validates the caller's membership and threads the workspace through
 * `mcpRequestWorkspace` (an AsyncLocalStorage) so the tool handlers see it.
 * `tools/list` returns that workspace's tools (namespaced) + the caller's
 * identity tools; `tools/call` is walled to it — a `ws_<other>-…` name is
 * `CrossWorkspaceReachDenied`. A request with no (or a non-member)
 * `X-Workspace-Id` is identity-only: any `ws_<id>-…` call is refused
 * (`WorkspaceToolUnavailable`).
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

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CreateTaskResult,
  ErrorCode,
  isInitializeRequest,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  type Resource,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { isToolEnabled, isToolVisibleToRole, type ResolvedFeatures } from "../config/features.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { log } from "../observability/log.ts";
import {
  ConnectorGrantDenied,
  routeToolCall,
  UnknownIdentitySource,
  UnknownNamespacedToolName,
  UnknownToolSource,
  WorkspaceAccessDenied,
} from "../orchestrator/index.ts";
import { assertToolAllowed } from "../permissions/assert-tool-allowed.ts";
import { type RequestContext, runWithRequestContext } from "../runtime/request-context.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { IDENTITY_SOURCES } from "../tools/identity-sources.ts";
import { McpSource } from "../tools/mcp-source.ts";
import { bareToolName, splitInnerToolName } from "../tools/namespace.ts";
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

/**
 * Per-request workspace for an identity-bound `/mcp` session, threaded from the
 * validated `X-Workspace-Id` header through `transport.handleRequest` so the
 * tool handlers can read it. A `/mcp` session has no fixed workspace; each
 * request names its focused workspace (the iframe bridge sends it on every
 * call). `undefined` = no workspace in scope → identity tools only.
 */
const mcpRequestWorkspace = new AsyncLocalStorage<string | undefined>();

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
 * evicted to make workspace — we never refuse a well-formed initialize.
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
   * Runtime handle used by `tools/list` (the caller's identity tools, via
   * `listIdentitySourceTools`) and `tools/call` (via the orchestrator's
   * `routeToolCall`). Optional for legacy unit tests that exercise only
   * reclamation / session-miss paths and never hit a tool handler; production
   * callers always pass the live runtime. When absent, `tools/list` returns an
   * empty list and `tools/call` rejects with `-32601 method not supported`.
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

  /**
   * Resolve the workspace a `/mcp` request is scoped to, from the
   * `X-Workspace-Id` header. Returns the workspace id ONLY if the session's
   * identity is a member of it — fail-closed: an absent header, an unknown
   * workspace, or a non-member yields `undefined` (identity tools only). The
   * web iframe bridge sends its active workspace here on every request; the
   * wall then bounds the session to that one workspace.
   */
  private async resolveRequestWorkspace(
    request: Request,
    sessionCtx: McpSessionContext,
  ): Promise<string | undefined> {
    const header = request.headers.get("x-workspace-id");
    const identityId = sessionCtx.identity?.id;
    if (!header || !identityId || !this.runtime) return undefined;
    const accessible = await this.runtime.getWorkspaceStore().getWorkspacesForUser(identityId);
    return accessible.some((w) => w.id === header) ? header : undefined;
  }

  private async handlePost(
    request: Request,
    features: ResolvedFeatures,
    sessionCtx: McpSessionContext,
  ): Promise<Response> {
    const sessionId = request.headers.get("mcp-session-id");

    if (sessionId) {
      // Debug-log once per session (under `NB_DEBUG=mcp`) that the client sent
      // an `X-Workspace-Id`. It IS honored per request — `resolveRequestWorkspace`
      // validates membership and the wall bounds the session to it below.
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
        // Bound this request to the validated `X-Workspace-Id` (the wall): the
        // tool handlers read it via `mcpRequestWorkspace`. No / invalid header →
        // identity tools only.
        const wsId = await this.resolveRequestWorkspace(request, sessionCtx);
        return mcpRequestWorkspace.run(wsId, () => local.transport.handleRequest(request));
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
   * Debug-log once per session that the client sent `X-Workspace-Id`. The
   * header IS honored: `resolveRequestWorkspace` validates membership and the
   * wall bounds each request to that workspace. The once-per-session line just
   * records which workspace a session first scoped to, for operator triage.
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
      `X-Workspace-Id on /mcp (sessionId=${sessionId.slice(0, 8)} value=${header}) — honored per request; the session is walled to it after membership validation`,
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
 * Create a new MCP Server instance for one session. Each session gets its
 * own Server + Transport pair.
 *
 * A `/mcp` session has no fixed workspace — it is walled per request to the
 * workspace named by a membership-validated `X-Workspace-Id` (threaded in via
 * `mcpRequestWorkspace`). `tools/list` serves that workspace's tools
 * (namespaced) plus the caller's identity tools (conversations / files /
 * automations); a request with no / non-member header is identity-only. Every
 * `tools/call` routes through `routeToolCall`, so a `ws_<other>-...` name is
 * refused (`CrossWorkspaceReachDenied`) and any `ws_<id>-...` on a
 * no-workspace request is `WorkspaceToolUnavailable`.
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
      // Unauthenticated / no-runtime path: empty list, not an error — the SDK
      // requires a response.
      return { tools: [] };
    }
    // Walled to the request's workspace (validated `X-Workspace-Id`): that
    // workspace's tools (namespaced) + the caller's identity tools. No workspace
    // in scope (e.g. an external client that sent no header) → identity tools
    // only; a `tools/call` on any `ws_<id>-...` name is then refused
    // (`WorkspaceToolUnavailable`).
    const wsId = mcpRequestWorkspace.getStore();
    const all = wsId
      ? await runtime.listToolsForWorkspace(wsId, identityId)
      : await runtime.listIdentitySourceTools();
    const orgRole = sessionCtx.identity?.orgRole;
    return {
      tools: all
        // Feature gating + role visibility apply to the BARE tool name.
        .filter((t) => isToolEnabled(bareToolName(t.name), features))
        .filter((t) => isToolVisibleToRole(bareToolName(t.name), orgRole))
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
    // routes. Each orchestrator error class maps to a distinct response shape
    // (the wall's two denials, `CrossWorkspaceReachDenied` and
    // `WorkspaceToolUnavailable`, share the `workspace_access_denied` reason).
    let routed: Awaited<ReturnType<typeof routeToolCall>>;
    try {
      routed = await routeToolCall({
        identityId,
        namespacedName: name,
        workspaceId: mcpRequestWorkspace.getStore(),
        runtime,
      });
    } catch (err) {
      mapRouteToolError(err);
    }

    // Identity request (bare `<source>__<tool>`): dispatch against the caller's
    // identity, no workspace. See `executeIdentityToolCall` for the rationale.
    if (routed.kind === "identity") {
      return executeIdentityToolCall(routed, name, args, features, sessionCtx, runtime);
    }
    return executeWorkspaceToolCall(
      routed,
      name,
      args,
      taskParam,
      runtime,
      features,
      sessionCtx,
      taskStore,
    );
  });

  // ── resources/list ────────────────────────────────────────────────
  //
  // Walled to the request's workspace (validated `X-Workspace-Id`), exactly
  // like `tools/list`: only that one workspace's sources are enumerated. No
  // workspace in scope (no / non-member header) → no workspace resources; the
  // session is identity-only. NEVER a sweep across every workspace the
  // identity belongs to — that was the cross-workspace read hole the wall
  // exists to close. Per-source errors are swallowed so one bad source doesn't
  // kill the listing.
  //
  // Pagination: MVP returns everything in a single response (no `cursor`
  // plumbing). The SDK type allows `nextCursor`, but iframe consumers today
  // enumerate the full list. Document here so we remember to add cursor
  // support if/when resource counts grow beyond a few hundred per workspace.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Resource[] = [];
    if (!runtime || !identityId) return { resources };

    const wsId = mcpRequestWorkspace.getStore();
    if (!wsId) return { resources };

    let wsRegistry: ToolRegistry;
    try {
      wsRegistry = await runtime.ensureWorkspaceRegistry(wsId);
    } catch {
      return { resources };
    }
    for (const src of wsRegistry.getSources()) {
      await collectSourceResources(src, resources);
    }
    return { resources };
  });

  // ── resources/read ────────────────────────────────────────────────
  //
  // Identity resources (files, conversations, automations) resolve first
  // (below), then the request's one workspace (validated `X-Workspace-Id`) —
  // never a sweep across every workspace the identity belongs to. We
  // deliberately do not distinguish "doesn't exist" from "exists but out of
  // reach": per MCP spec guidance, avoid leaking cross-workspace existence.
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
      // Files are workspace-owned: `files://` resolves in the request's
      // validated workspace; undefined ⇒ not found (the resources wall denies).
      fileWorkspaceId: mcpRequestWorkspace.getStore(),
    };
    const identityResult = await readResourceFromIdentitySources(runtime, uri, identityReqCtx);
    if (identityResult) return identityResult;

    // Walled to the request's workspace (validated `X-Workspace-Id`). With no
    // workspace in scope the read falls through to not-found below — an
    // identity-only session reads its identity resources (above) and nothing
    // else. NEVER a sweep across every workspace the identity belongs to.
    const wsId = mcpRequestWorkspace.getStore();
    if (wsId) {
      const wsResult = await readResourceFromWorkspace(runtime, uri, wsId);
      if (wsResult) return wsResult;
    }

    // The URI resolved in neither the caller's identity sources nor the
    // focused workspace. Per MCP spec, raise a JSON-RPC error — the SDK
    // transport converts McpError into a proper `error` envelope.
    throw new McpError(RESOURCE_NOT_FOUND_CODE, `Resource not found: ${uri}`, { uri });
  });

  return server;
}

// ── /mcp CallTool + resource dispatch helpers ──────────────────────────────

type IdentityRoute = Extract<Awaited<ReturnType<typeof routeToolCall>>, { kind: "identity" }>;
type WorkspaceRoute = Extract<Awaited<ReturnType<typeof routeToolCall>>, { kind: "workspace" }>;
type TaskAwareSourceHandle = NonNullable<ReturnType<ToolRegistry["findTaskAwareSource"]>>;
type CallToolTaskParam = CallToolRequest["params"]["task"];

/** Shape an engine ToolResult into an MCP CallToolResult, preserving optional structuredContent. */
function toCallToolResult(result: ToolResult) {
  return {
    content: result.content,
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    isError: result.isError,
  };
}

/**
 * Map an orchestrator routing error to its MCP JSON-RPC error, re-throwing
 * anything unrecognized. Each error class maps to a distinct response shape;
 * `error.data.reason` carries the precise classification. (The wall's two
 * denials, `CrossWorkspaceReachDenied` and `WorkspaceToolUnavailable`, both
 * arrive as `WorkspaceAccessDenied` and share the `workspace_access_denied`
 * reason.)
 */
function mapRouteToolError(err: unknown): never {
  if (err instanceof UnknownNamespacedToolName) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid tool name: expected ws_<id>-<tool>`, {
      reason: "invalid_tool_name",
      input: err.input,
      parse: err.reason,
    });
  }
  if (err instanceof WorkspaceAccessDenied) {
    // No spec-blessed JSON-RPC code for "permission denied", but
    // `-32603 Internal error` is too broad — the call IS well-formed, it just
    // isn't allowed for this identity. The MCP draft's tasks spec sets the
    // precedent of using `-32602` for owner-mismatch task lookups; we mirror
    // that here so a misrouted call doesn't get classified as a server bug.
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
  if (err instanceof ConnectorGrantDenied) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Personal connector "${err.connector}" is not granted to this workspace`,
      { reason: "connector_grant_denied", connector: err.connector, wsId: err.workspaceId },
    );
  }
  throw err;
}

/**
 * Dispatch an identity-scoped `/mcp` tools/call (bare `<source>__<tool>`)
 * against the caller's identity, no workspace. `workspaceId: null` is safe — a
 * handler that needs a workspace calls `requireWorkspaceId()`, which hard-fails
 * (never a passive failover). Identity tools (conversations) aren't
 * task-augmented, so the workspace task-negotiation is skipped; entity reads
 * are gated by `canAccess` in the handler.
 */
async function executeIdentityToolCall(
  routed: IdentityRoute,
  name: string,
  args: Record<string, unknown> | undefined,
  features: ResolvedFeatures,
  sessionCtx: McpSessionContext,
  runtime: Runtime,
) {
  const fullName = routed.toolName;
  if (!isToolEnabled(fullName, features)) {
    return {
      content: [{ type: "text" as const, text: `Tool "${name}" is disabled` }],
      isError: true,
    };
  }
  // Role-gate at DISPATCH, not just surfacing — the workspace branch and the
  // REST handler both do, and surfacing already hides role-gated identity
  // tools, so a crafted bare `tools/call` must not slip past. (No identity tool
  // is role-gated today; this closes the gap before files/automations land an
  // admin-gated one.)
  if (!isToolVisibleToRole(fullName, sessionCtx.identity?.orgRole)) {
    return {
      content: [{ type: "text" as const, text: `Tool "${name}" is not available` }],
      isError: true,
    };
  }
  const { sourcePrefix, bareToolName: bare } = splitInnerToolName(fullName);

  // Per-tool `disallow` gate for a personal connector reached via the identity
  // door — honor the OWNER'S policy from its home workspace (`policyWorkspaceId`,
  // stamped at routing), the same policy the workspace door consults at home, so
  // a shared room is never more capable than home. Kernel identity sources have
  // no `policyWorkspaceId` and are skipped.
  if (routed.policyWorkspaceId) {
    const denied = await assertToolAllowed(
      runtime.getPermissionStore(),
      routed.policyWorkspaceId,
      sourcePrefix,
      bare,
    );
    if (denied) return toCallToolResult(denied);
  }

  const identityCtx: RequestContext = {
    identity: sessionCtx.identity ?? null,
    scope: { kind: "identity" },
    // Files are workspace-owned: a `files__*` call resolves in the request's
    // validated workspace; undefined (no / non-member header) ⇒ the file tool
    // denies, consistent with the resources wall.
    fileWorkspaceId: mcpRequestWorkspace.getStore(),
  };
  const idResult = await runWithRequestContext(identityCtx, () =>
    routed.source.execute(bare, (args ?? {}) as Record<string, unknown>),
  );
  return toCallToolResult(idResult);
}

/**
 * Dispatch a workspace-scoped `/mcp` tools/call (`ws_<id>-<tool>`): feature +
 * role gating, connector permission gate, tool-level task negotiation, then the
 * task-augmented or inline execution path. The workspace ID comes from the
 * parsed namespace (`routed.context`), never from session-level state.
 */
async function executeWorkspaceToolCall(
  routed: WorkspaceRoute,
  name: string,
  args: Record<string, unknown> | undefined,
  taskParam: CallToolTaskParam,
  runtime: Runtime,
  features: ResolvedFeatures,
  sessionCtx: McpSessionContext,
  taskStore: McpTaskStore | undefined,
) {
  const isTaskRequest = taskParam !== undefined;
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

  // The orchestrator's parse already split `innerToolName` into
  // `<source>__<tool>`; reuse that split here.
  const sepIndex = innerToolName.indexOf("__");
  const sourceName = sepIndex >= 0 ? innerToolName.slice(0, sepIndex) : null;
  const localName = sepIndex >= 0 ? innerToolName.slice(sepIndex + 2) : innerToolName;
  const wsId = workspaceContext.workspaceId;

  // Connector permission gate. Runs BEFORE the task-vs-inline negotiation below
  // so an operator's `disallow` is honored whether or not the tool is
  // task-augmented — a disallowed task tool must be denied just like an inline
  // one. Mirrors the engine door (`IdentityToolRouter`) and the REST registry
  // gate, so all three doors enforce the same workspace policy.
  if (sourceName) {
    const denied = await assertToolAllowed(
      runtime.getPermissionStore(),
      wsId,
      sourceName,
      localName,
    );
    if (denied) return toCallToolResult(denied);
  }

  const wsRegistry = runtime.getRegistryForWorkspace(wsId);
  const taskAwareSource = sourceName ? wsRegistry.findTaskAwareSource(sourceName) : null;
  const taskSupport = await resolveTaskSupport(taskAwareSource, innerToolName);

  assertTaskNegotiation(name, taskSupport, isTaskRequest);

  // Build per-request context for AsyncLocalStorage (concurrency-safe). The
  // workspace ID is derived from the parsed namespace — NOT from any
  // session-level state. This is the per-call routing the orchestrator exists
  // to enforce.
  const reqCtx: RequestContext = {
    identity: sessionCtx.identity ?? null,
    scope: {
      kind: "workspace",
      workspaceId: wsId,
      workspaceAgents: null,
      workspaceModelOverride: null,
    },
  };

  if (isTaskRequest && taskAwareSource && taskStore) {
    return startWorkspaceTask(
      taskParam,
      taskAwareSource,
      taskStore,
      reqCtx,
      localName,
      innerToolName,
      args,
      wsId,
      sessionCtx,
    );
  }

  // ── Inline path ────────────────────────────────────────────────────────────
  //
  // Dispatch via the resolved source directly (the orchestrator already looked
  // it up and returned it). `ToolSource.execute` takes the bare (post-`__`)
  // tool name, mirroring `ToolRegistry.execute`'s contract. Preserve
  // `structuredContent` — dropping it silently violated `CallToolResult must be
  // returned as-is`. `_meta` propagation is a no-op today because the engine's
  // ToolResult shape doesn't carry `_meta`; task-augmented flows carry `_meta`
  // through naturally because `tasks/result` returns the full CallToolResult
  // directly from `awaitToolTaskResult` (see mcp-task-store.ts).
  const result = await runWithRequestContext(reqCtx, () =>
    source.execute(localName, (args ?? {}) as Record<string, unknown>),
  );
  return toCallToolResult(result);
}

/**
 * Read a task-aware source's `taskSupport` for one tool. Inspects the cached
 * tool definition (MCP-backed sources only); returns undefined when the source
 * is non-task-aware (never supports tasks) or the tool is unknown.
 */
async function resolveTaskSupport(
  taskAwareSource: TaskAwareSourceHandle | null,
  innerToolName: string,
): Promise<"optional" | "required" | "forbidden" | undefined> {
  if (!taskAwareSource) return undefined;
  const tools = await taskAwareSource.tools();
  const tool = tools.find((t) => t.name === innerToolName);
  return tool?.execution?.taskSupport;
}

/**
 * Enforce tool-level task negotiation (MCP spec 2025-11-25 §tasks). The
 * low-level SDK `Server` validates the result shape but NOT the tool-level
 * taskSupport semantics, so we do it here: `required` without a task param and
 * a task param against a `forbidden`/absent tool both reject with -32601;
 * `optional` allows either path.
 */
function assertTaskNegotiation(
  name: string,
  taskSupport: "optional" | "required" | "forbidden" | undefined,
  isTaskRequest: boolean,
): void {
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
}

/**
 * Task-augmented workspace dispatch (MCP spec 2025-11-25 §tasks). Returns a
 * CreateTaskResult immediately; the McpSource has already started the stream and
 * is draining it in the background. Stashes the (source, owner) pair in the
 * session's task store so the SDK-installed task handlers can find their way
 * back for later `tasks/result` and `tasks/cancel`.
 */
async function startWorkspaceTask(
  taskParam: NonNullable<CallToolTaskParam>,
  taskAwareSource: TaskAwareSourceHandle,
  taskStore: McpTaskStore,
  reqCtx: RequestContext,
  localName: string,
  innerToolName: string,
  args: Record<string, unknown> | undefined,
  wsId: string,
  sessionCtx: McpSessionContext,
): Promise<CreateTaskResult> {
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

/**
 * Append one MCP source's resources to `out`. Non-MCP and clientless sources are
 * skipped; per-source errors are swallowed so one bad source doesn't kill the
 * listing.
 */
async function collectSourceResources(src: unknown, out: Resource[]): Promise<void> {
  if (!(src instanceof McpSource)) return;
  const client = src.getClient();
  if (!client) return;
  try {
    const result = await client.listResources();
    for (const r of result.resources) {
      out.push(r as Resource);
    }
  } catch {
    // Source didn't implement resources/list, or transport hiccup — swallow so
    // one bad source doesn't kill the listing.
  }
}

/**
 * Read `uri` from one source if it's an MCP source with a live client, running
 * the read through `run` (identity context for identity sources, pass-through
 * for workspace sources). Returns the result only when it carries contents;
 * null otherwise, including on error.
 */
async function tryReadResource(
  src: unknown,
  uri: string,
  run: (read: () => Promise<ReadResourceResult>) => Promise<ReadResourceResult>,
): Promise<ReadResourceResult | null> {
  if (!(src instanceof McpSource)) return null;
  const client = src.getClient();
  if (!client) return null;
  try {
    const result = await run(() => client.readResource({ uri }));
    if (result.contents && result.contents.length > 0) return result;
  } catch {
    // Not this source, or not found here — the caller tries the next source and
    // ultimately the workspace sweep.
  }
  return null;
}

/**
 * Try the caller's kernel identity sources (files, conversations, automations)
 * for `uri`, each within the identity request context. Returns the first result
 * that carries contents, or null.
 */
async function readResourceFromIdentitySources(
  runtime: Runtime,
  uri: string,
  identityReqCtx: RequestContext,
): Promise<ReadResourceResult | null> {
  for (const sourceName of IDENTITY_SOURCES) {
    const src = runtime.getIdentitySource(sourceName);
    const result = await tryReadResource(src, uri, (read) =>
      runWithRequestContext(identityReqCtx, read),
    );
    if (result) return result;
  }
  return null;
}

/**
 * Sweep the focused workspace's MCP sources for `uri` (the validated
 * `X-Workspace-Id`) — never a sweep across every workspace the identity belongs
 * to. Returns the first result that carries contents, or null.
 */
async function readResourceFromWorkspace(
  runtime: Runtime,
  uri: string,
  wsId: string,
): Promise<ReadResourceResult | null> {
  let wsRegistry: ToolRegistry | undefined;
  try {
    wsRegistry = await runtime.ensureWorkspaceRegistry(wsId);
  } catch {
    wsRegistry = undefined;
  }
  for (const src of wsRegistry?.getSources() ?? []) {
    const result = await tryReadResource(src, uri, (read) => read());
    if (result) return result;
  }
  return null;
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
