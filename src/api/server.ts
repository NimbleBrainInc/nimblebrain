type BunServer = ReturnType<typeof Bun.serve>;

import { log } from "../cli/log.ts";
import type { IdentityProvider } from "../identity/provider.ts";
import { DevIdentityProvider } from "../identity/providers/dev.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { HealthMonitor } from "../tools/health-monitor.ts";
import { createApp } from "./app.ts";
import { resolveAuthMode } from "./auth-middleware.ts";
import { ConversationEventManager } from "./conversation-events.ts";
import { SseEventManager } from "./events.ts";
import { McpServerHost } from "./mcp-server.ts";
import { LoginRateLimiter, RequestRateLimiter } from "./rate-limiter.ts";
import { InMemorySessionRegistry, type SessionRegistry } from "./session-store/index.ts";
import type { AppContext } from "./types.ts";

export interface ServerOptions {
  runtime: Runtime;
  port?: number;
  /** Pluggable identity provider. Falls back to DevIdentityProvider (no auth) when null. */
  provider?: IdentityProvider | null;
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
  healthMonitor: HealthMonitor;
  sseManager: SseEventManager;
  /** Shorthand for server.port */
  port: number;
  /** Scoped internal token for protected default bundles. Rotated on every restart. */
  internalToken: string;
  /** Stop the server and health monitor. */
  stop(closeConnections?: boolean): void;
}

/** Parse ALLOWED_ORIGINS env var into a Set. */
const allowedOrigins: Set<string> | null = process.env.ALLOWED_ORIGINS
  ? new Set(
      process.env.ALLOWED_ORIGINS.split(",")
        .map((o) => o.trim())
        .filter(Boolean),
    )
  : null;

/**
 * Start an HTTP API server wrapping a Runtime instance.
 *
 * Uses Hono for routing and middleware composition.
 * Creates a HealthMonitor for MCP bundle sources and starts it.
 * Returns a ServerHandle for lifecycle control.
 */
export function startServer(options: ServerOptions): ServerHandle {
  const { runtime, port = 27247, provider: optProvider = null } = options;
  // Read the scoped internal token minted by the runtime at startup.
  const internalToken = runtime.getInternalToken();

  const mcpSources = runtime.mcpSources();
  const healthMonitor = new HealthMonitor(mcpSources, runtime.getEventSink());
  healthMonitor.start();

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

  // Login rate limiter — per-IP brute-force protection
  const rateLimiter = new LoginRateLimiter();
  rateLimiter.start();

  // Per-identity request rate limiters. The limit lives on the caller's
  // trust class, not "is it expensive":
  //   - `/mcp` (mcpLimiter) is the remote/untrusted surface — external MCP
  //     clients and sandboxed bundle iframes. This is the real abuse vector,
  //     so it carries a present-but-generous cap.
  //   - `/v1/tools/call` (toolCallLimiter) is the trusted first-party shell.
  //     Its only failure mode is a runaway client loop, so the ceiling is
  //     high — far above human navigation, low enough to stop a hot loop.
  //   - `/v1/chat` (chatLimiter) is first-party + LLM-expensive, so it stays
  //     modest.
  // All are bypassed in dev mode (see `isDevMode` below).
  const chatRateLimit = Number(process.env.NB_CHAT_RATE_LIMIT) || 20;
  const toolRateLimit = Number(process.env.NB_TOOL_RATE_LIMIT) || 600;
  const mcpRateLimit = Number(process.env.NB_MCP_RATE_LIMIT) || 300;
  const chatLimiter = new RequestRateLimiter(chatRateLimit, 60_000);
  chatLimiter.start();
  const toolCallLimiter = new RequestRateLimiter(toolRateLimit, 60_000);
  toolCallLimiter.start();
  const mcpLimiter = new RequestRateLimiter(mcpRateLimit, 60_000);
  mcpLimiter.start();

  // Wire runtime events to the SSE manager by subscribing to the event sink.
  const runtimeSink = runtime.getEventSink();
  const originalEmit = runtimeSink.emit.bind(runtimeSink);
  runtimeSink.emit = (event) => {
    // Trace every progress/completion event that reaches the runtime sink.
    // Answers "is the event source actually firing into the SSE wrap?" —
    // the first thing to check when a bundle's UI isn't updating live.
    // Run with `NB_DEBUG=sse` to enable.
    if ((event.type === "tool.progress" || event.type === "tool.done") && log.debugEnabled("sse")) {
      log.debug("sse", `sink got ${event.type} data=${JSON.stringify(event.data).slice(0, 160)}`);
    }
    originalEmit(event);
    sseManager.emit(event);

    // Broadcast `data.changed` so bundle iframes (Synapse useDataSync) know to
    // refresh. We broadcast in two situations:
    //
    //   (1) tool.done (ok)      — the call completed; any entity writes have
    //                             landed and downstream views should refresh.
    //   (2) tool.progress       — the call is long-running (task-augmented)
    //                             and the server has emitted a status update.
    //                             Long-running tools typically write entity
    //                             state on each phase, so the UI needs to see
    //                             the work-in-progress, not only the final
    //                             result. Without this, a `useDataSync`-driven
    //                             view stays stale for the full task duration.
    //
    // System tools (`nb__*`) are filtered out of both paths — they don't
    // modify app data, and broadcasting data.changed for them would make
    // iframes re-fetch during every streaming chunk (flicker + tool-call
    // amplification).
    const progressOrDone =
      (event.type === "tool.done" && event.data.ok === true) || event.type === "tool.progress";
    if (progressOrDone) {
      const toolName =
        (event.data.name as string | undefined) ??
        // tool.progress uses `source`+`tool` (McpSource emits them separately)
        // while tool.done uses a single qualified `name`. Handle both shapes.
        ((): string | undefined => {
          const src = event.data.source as string | undefined;
          const tool = event.data.tool as string | undefined;
          return src && tool ? `${src}__${tool}` : undefined;
        })();
      if (toolName) {
        const sepIndex = toolName.indexOf("__");
        const server = sepIndex !== -1 ? toolName.slice(0, sepIndex) : toolName;
        const tool = sepIndex !== -1 ? toolName.slice(sepIndex + 2) : toolName;
        if (server !== "nb") {
          // Confirms `data.changed` is actually being broadcast, and to how
          // many clients. If this fires but the browser never sees the
          // event, the break is in the SSE connection or the
          // parent `useDataSync` forwarder — not here.
          log.debug(
            "sse",
            `broadcast data.changed from=${event.type} server=${server} tool=${tool} clients=${sseManager.clientCount}`,
          );
          sseManager.broadcast("data.changed", {
            server,
            tool,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  };

  // Resolve identity provider. `isDevMode` is captured BEFORE the dev
  // substitution: when no real provider is configured we still install a
  // DevIdentityProvider (so the local app authenticates as a single
  // `usr_default`), which makes `authMode` look like a real adapter. The
  // honest "is this local dev" signal is therefore "was a real provider
  // configured", not the post-substitution auth mode. Request rate limiting
  // keys off this to bypass in dev.
  let effectiveProvider: IdentityProvider | null = optProvider ?? runtime.getIdentityProvider();
  const isDevMode = effectiveProvider === null;
  if (!effectiveProvider) {
    const workDir = runtime.getWorkDir();
    effectiveProvider = new DevIdentityProvider(
      workDir,
      runtime.getUserStore(),
      runtime.getWorkspaceStore(),
    );
  }
  const authMode = resolveAuthMode(effectiveProvider);
  const authConfigured = authMode.type !== "dev";

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
    authOptions: { mode: authMode, internalToken, eventSink: runtime.getEventSink() },
    provider: effectiveProvider,
    workspaceStore: runtime.getWorkspaceStore(),
    healthMonitor,
    sseManager,
    conversationEventManager,
    rateLimiter,
    chatLimiter,
    toolCallLimiter,
    mcpLimiter,
    isDevMode,
    eventSink: runtime.getEventSink(),
    isLocalhost: true, // Updated after Bun.serve starts
    appOrigin: allowedOrigins ? [...allowedOrigins][0] : undefined,
    internalToken,
    mcpHost,
  };

  const app = createApp(ctx, authConfigured, allowedOrigins);

  const server = Bun.serve({
    port,
    idleTimeout: 255, // seconds — max Bun allows; needed for SSE streams and long chat requests
    fetch: app.fetch,
  });

  const host = server.hostname;
  ctx.isLocalhost =
    host === "127.0.0.1" || host === "::1" || host === "localhost" || host === "0.0.0.0";

  return {
    server,
    healthMonitor,
    sseManager,
    internalToken,
    get port(): number {
      return server.port as number;
    },
    stop(closeConnections = false) {
      rateLimiter.stop();
      chatLimiter.stop();
      toolCallLimiter.stop();
      mcpLimiter.stop();
      sseManager.stop();
      conversationEventManager.stop();
      healthMonitor.stop();
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

  console.error(`[nimblebrain] HTTP server listening on port ${handle.port}`);

  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) {
      console.error("[nimblebrain] Forced shutdown.");
      process.exit(1);
    }
    shuttingDown = true;
    console.error("[nimblebrain] Shutting down HTTP server... (press Ctrl+C again to force)");

    const safetyTimeout = setTimeout(() => {
      console.error("[nimblebrain] Shutdown timed out after 10s, forcing exit.");
      process.exit(1);
    }, 10_000);

    handle.stop(true);
    await runtime.shutdown();

    clearTimeout(safetyTimeout);
    console.error("[nimblebrain] Shutdown complete.");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Keep the process alive
  await new Promise(() => {});
}
