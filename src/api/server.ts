type BunServer = ReturnType<typeof Bun.serve>;

import type { Hono } from "hono";
import type { ConnectionHealthProbe } from "../connectors/runtime/connection-probe.ts";
import {
  ConnectionRevalidator,
  revalidatorIntervalMsFromEnv,
} from "../connectors/runtime/connection-revalidator.ts";
import { canonicalOrigins, webOrigin } from "../oauth/public-origin.ts";
import { shutdownTracing } from "../observability/index.ts";
import { log } from "../observability/log.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { HealthMonitor } from "../tools/health-monitor.ts";
import { createApp } from "./app.ts";
import { ConversationEventManager } from "./conversation-events.ts";
import { SseEventManager } from "./events.ts";
import { McpServerHost } from "./mcp-server.ts";
import { registerConnectorHealthGauge } from "./metrics.ts";
import { RequestRateLimiter } from "./rate-limiter.ts";
import {
  HOOK_ANON_BUCKET_MAX,
  HOOK_BUCKET_WINDOW_MS,
  HOOK_WORKSPACE_BUCKET_MAX,
} from "./routes/hooks.ts";
import { InMemorySessionRegistry, type SessionRegistry } from "./session-store/index.ts";
import type { AppContext } from "./types.ts";

export interface ServerOptions {
  runtime: Runtime;
  port?: number;
  /**
   * Pluggable cluster-shared session metadata store. When omitted, a process-
   * local in-memory registry is constructed with the runtime's configured TTL
   * — equivalent to legacy single-pod behavior. Multi-replica deploys must
   * pass a Redis-backed registry built via `createSessionRegistry`.
   */
  sessionRegistry?: SessionRegistry;
}

export interface ServerHandle {
  server: BunServer;
  /** The Hono app the server serves; its `routes` are the route table. */
  app: Hono;
  healthMonitor: HealthMonitor;
  sseManager: SseEventManager;
  /** Shorthand for server.port */
  port: number;
  /** Stop the server and health monitor. */
  stop(closeConnections?: boolean): void;
}

/**
 * Parse ALLOWED_ORIGINS env var into a Set of *additional* CORS origins. The
 * canonical hosts (custom domain + platform subdomain) are folded in separately
 * via `canonicalOrigins()` at server start, so they never need to be listed
 * here by hand. `null` (var unset) allows same-origin requests only. Read when
 * a server starts, so the allowlist is the environment of that start.
 */
function readEnvAllowedOrigins(): Set<string> | null {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return null;
  return new Set(
    raw
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  );
}

/**
 * Start an HTTP API server wrapping a Runtime instance.
 *
 * Uses Hono for routing and middleware composition.
 * Creates a HealthMonitor for MCP connector sources and starts it.
 * Returns a ServerHandle for lifecycle control.
 */
export function startServer(options: ServerOptions): ServerHandle {
  const { runtime, port = 27247 } = options;
  // The runtime owns the identity provider; the server authenticates with that
  // one and has none of its own, so the two cannot disagree about who a caller
  // is. A runtime always has one: `Runtime.start` refuses a workdir without
  // `instance.json`.
  const provider = runtime.getIdentityProvider();

  // Effective CORS allowlist = operator-declared extras (ALLOWED_ORIGINS) ∪ the
  // canonical hosts (custom domain + platform subdomain). Folding the canonical
  // origins in here means they're always allowed without being listed by hand.
  // `null` (no ALLOWED_ORIGINS) allows same-origin requests only.
  const envAllowedOrigins = readEnvAllowedOrigins();
  const allowedOrigins: Set<string> | null = envAllowedOrigins
    ? new Set([...envAllowedOrigins, ...canonicalOrigins()])
    : null;

  const healthMonitor = new HealthMonitor(() => runtime.mcpSources(), runtime.getEventSink());
  healthMonitor.start();
  // Expose currently-down connectors as the `nb_connector_unhealthy` gauge (read
  // through this provider at scrape time). The gauge stays asserted for the
  // whole outage, unlike the crash counter which goes flat once a source is
  // dead-terminal — so the down-alert resolves only on recovery.
  registerConnectorHealthGauge(() => healthMonitor.getStatus());

  // Connection credential re-validation (a disjoint concern from HealthMonitor's
  // transport liveness): poll brokered providers whose upstream account can lapse
  // without a transport 401 and flip stale connections to reauth_required.
  // Each registered managed-connector provider contributes its own probe (or
  // none) — a provider-less deploy wires nothing, and a provider that suppresses
  // its probe (a per-provider monitor kill switch, config- or env-declared) simply
  // omits it. Sweep cadence: NB_CONNECTION_REVALIDATE_INTERVAL_SECONDS (default 300).
  const revalidatorProbes: ConnectionHealthProbe[] = [];
  for (const provider of runtime.getManagedConnectorRegistry().list()) {
    const probe = provider.probe?.(runtime.getConnectorCatalog());
    if (probe) revalidatorProbes.push(probe);
  }
  const intervalMs = revalidatorIntervalMsFromEnv();
  const connectionRevalidator = new ConnectionRevalidator(
    runtime.getLifecycle(),
    revalidatorProbes,
    intervalMs !== undefined ? { intervalMs } : {},
  );
  connectionRevalidator.start();

  // SSE event manager — listens to runtime events and broadcasts to clients.
  // Wired with the workspace store so `addIdentityClient` (the /v1/events
  // route) can compute initial memberships and the manager can refresh a
  // connected client's cached set on in-process membership-change events.
  const sseManager = new SseEventManager(undefined, runtime.getWorkspaceStore());
  sseManager.start();

  // Per-conversation event manager — streams chat events to conversation participants
  const conversationEventManager = new ConversationEventManager();
  conversationEventManager.start();

  // Bridge detached-turn events (RunBus) to the per-conversation SSE manager
  // so connected viewers tail live. Replay-on-connect is sourced separately
  // from the RunBus buffer (see the conversation-events route).
  runtime.onTurnEvent = (conversationId, event) => {
    conversationEventManager.publishEvent(conversationId, event);
  };

  // Per-identity request rate limiters. The limit lives on the caller's
  // trust class, not "is it expensive":
  //   - `/mcp` (mcpLimiter) is the remote/untrusted surface — external MCP
  //     clients and sandboxed connector iframes. This is the real abuse vector,
  //     so it carries a present-but-generous cap.
  //   - `/v1/workspaces/:wsId/tools/call` (toolCallLimiter) is the trusted first-party shell.
  //     Its only failure mode is a runaway client loop, so the ceiling is
  //     high — far above human navigation, low enough to stop a hot loop.
  //   - `/v1/workspaces/:wsId/chat` (chatLimiter) is first-party + LLM-expensive, so it stays
  //     modest.
  const chatRateLimit = Number(process.env.NB_CHAT_RATE_LIMIT) || 20;
  const toolRateLimit = Number(process.env.NB_TOOL_RATE_LIMIT) || 600;
  const mcpRateLimit = Number(process.env.NB_MCP_RATE_LIMIT) || 300;
  const chatLimiter = new RequestRateLimiter(chatRateLimit, 60_000);
  chatLimiter.start();
  const toolCallLimiter = new RequestRateLimiter(toolRateLimit, 60_000);
  toolCallLimiter.start();
  const mcpLimiter = new RequestRateLimiter(mcpRateLimit, 60_000);
  mcpLimiter.start();
  // The hooks door's buckets. See `AppContext.hookAnonLimiter` for why they are
  // owned here: `stop()` below has to be able to clear their sweep timers.
  const hookAnonLimiter = new RequestRateLimiter(HOOK_ANON_BUCKET_MAX, HOOK_BUCKET_WINDOW_MS);
  hookAnonLimiter.start();
  const hookWorkspaceLimiter = new RequestRateLimiter(
    HOOK_WORKSPACE_BUCKET_MAX,
    HOOK_BUCKET_WINDOW_MS,
  );
  hookWorkspaceLimiter.start();

  // Wire runtime events to the SSE manager by subscribing to the event sink.
  const runtimeSink = runtime.getEventSink();
  const originalEmit = runtimeSink.emit.bind(runtimeSink);
  runtimeSink.emit = (event) => {
    // Trace every progress/completion event that reaches the runtime sink.
    // Answers "is the event source actually firing into the SSE wrap?" —
    // the first thing to check when a connector's UI isn't updating live.
    // Run with `NB_DEBUG=sse` to enable.
    if (
      (event.type === "tool.progress" ||
        event.type === "tool.task_status" ||
        event.type === "tool.done" ||
        event.type === "server.notification") &&
      log.debugEnabled("sse")
    ) {
      log.debug("sse", `sink got ${event.type} data=${JSON.stringify(event.data).slice(0, 160)}`);
    }
    originalEmit(event);
    sseManager.emit(event);
  };

  // Construct the per-pod MCP host. The transport map lives here; the
  // session-metadata registry is either supplied by the caller (production
  // bootstrap building a Redis registry from config) or defaulted to an
  // in-memory store using the runtime's configured TTL.
  const sessionTtlMs = runtime.getSessionStoreTtlMs();
  const sessionRegistry: SessionRegistry =
    options.sessionRegistry ?? new InMemorySessionRegistry({ ttlMs: sessionTtlMs });
  // The host's idle-eviction TTL mirrors the registry's TTL: both layers
  // reclaim the same logical session on the same schedule, with the host's
  // sweep being what actually frees the JS heap. The registry TTL is a
  // backstop on the metadata layer for the cluster-shared view.
  const mcpHost = new McpServerHost({
    registry: sessionRegistry,
    runtime,
    idleTtlMs: sessionTtlMs,
  });

  // Build shared context for all route groups
  const ctx: AppContext = {
    runtime,
    features: runtime.getFeatures(),
    authOptions: { provider, eventSink: runtime.getEventSink() },
    provider,
    workspaceStore: runtime.getWorkspaceStore(),
    sseManager,
    conversationEventManager,
    chatLimiter,
    hookAnonLimiter,
    hookWorkspaceLimiter,
    toolCallLimiter,
    mcpLimiter,
    eventSink: runtime.getEventSink(),
    // Every provider's cookies are `Secure`. A deployment is fronted by a
    // TLS-terminating edge, so the browser↔edge leg is HTTPS regardless of the
    // container's plain-HTTP listen address, and browsers treat
    // http://localhost as a secure context. Deriving this from the listen
    // address is wrong: Bun binds `0.0.0.0` in production.
    secureCookies: true,
    // Post-login landing — a user-facing browser destination, so it uses
    // webOrigin() like the connectors return (one rule: browser-facing →
    // webOrigin, vendor-facing → publicOrigin). Identical to publicOrigin() in
    // prod; decoupled from the CORS allowlist (no longer ALLOWED_ORIGINS[0]).
    appOrigin: webOrigin(),
    mcpHost,
  };

  const app = createApp(ctx, allowedOrigins);

  const server = Bun.serve({
    port,
    idleTimeout: 255, // seconds — max Bun allows; needed for SSE streams and long chat requests
    fetch: app.fetch,
  });

  return {
    server,
    app,
    healthMonitor,
    sseManager,
    get port(): number {
      return server.port as number;
    },
    stop(closeConnections = false) {
      chatLimiter.stop();
      toolCallLimiter.stop();
      mcpLimiter.stop();
      hookAnonLimiter.stop();
      hookWorkspaceLimiter.stop();
      sseManager.stop();
      conversationEventManager.stop();
      healthMonitor.stop();
      connectionRevalidator.stop();
      mcpHost.shutdown().catch(() => {});
      server.stop(closeConnections);
    },
  };
}

/**
 * Start the server with graceful shutdown on SIGTERM/SIGINT.
 * Logs the port to stderr.
 */
export async function startServerWithShutdown(options: ServerOptions): Promise<void> {
  const handle = startServer(options);
  const { runtime } = options;

  log.info(`[nimblebrain] HTTP server listening on port ${handle.port}`);

  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) {
      log.error("[nimblebrain] Forced shutdown.");
      process.exit(1);
    }
    shuttingDown = true;
    log.info("[nimblebrain] Shutting down HTTP server... (press Ctrl+C again to force)");

    const safetyTimeout = setTimeout(() => {
      log.error("[nimblebrain] Shutdown timed out after 10s, forcing exit.");
      process.exit(1);
    }, 10_000);

    handle.stop(true);
    await runtime.shutdown();
    // Flush any buffered spans before exit so the final window isn't dropped on
    // pod termination (BatchSpanProcessor schedule is ~5s). No-op without export.
    await shutdownTracing();

    clearTimeout(safetyTimeout);
    log.info("[nimblebrain] Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep the process alive
  await new Promise(() => {});
}
