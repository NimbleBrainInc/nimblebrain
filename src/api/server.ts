type BunServer = ReturnType<typeof Bun.serve>;

import type { IdentityProvider } from "../identity/provider.ts";
import { DevIdentityProvider } from "../identity/providers/dev.ts";
import type { Runtime } from "../runtime/runtime.ts";
import { HealthMonitor } from "../tools/health-monitor.ts";
import { createApp } from "./app.ts";
import { resolveAuthMode } from "./auth-middleware.ts";
import { ConversationEventManager } from "./conversation-events.ts";
import { SseEventManager } from "./events.ts";
import { closeAllMcpSessions } from "./mcp-server.ts";
import { LoginRateLimiter, RequestRateLimiter } from "./rate-limiter.ts";
import type { AppContext } from "./types.ts";

export interface ServerOptions {
  runtime: Runtime;
  port?: number;
  /** Pluggable identity provider. Falls back to DevIdentityProvider (no auth) when null. */
  provider?: IdentityProvider | null;
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

  // SSE event manager — listens to runtime events and broadcasts to clients
  const sseManager = new SseEventManager();
  sseManager.start();

  // Per-conversation event manager — streams chat events to conversation participants
  const conversationEventManager = new ConversationEventManager();
  conversationEventManager.start();
  runtime.setConversationEventManager(conversationEventManager);

  // Login rate limiter — per-IP brute-force protection
  const rateLimiter = new LoginRateLimiter();
  rateLimiter.start();

  // Per-user request rate limiters for expensive endpoints
  const chatRateLimit = Number(process.env.NB_CHAT_RATE_LIMIT) || 20;
  const toolRateLimit = Number(process.env.NB_TOOL_RATE_LIMIT) || 60;
  const chatLimiter = new RequestRateLimiter(chatRateLimit, 60_000);
  chatLimiter.start();
  const toolCallLimiter = new RequestRateLimiter(toolRateLimit, 60_000);
  toolCallLimiter.start();

  // Wire runtime events to the SSE manager by subscribing to the event sink.
  const runtimeSink = runtime.getEventSink();
  const originalEmit = runtimeSink.emit.bind(runtimeSink);
  runtimeSink.emit = (event) => {
    originalEmit(event);
    sseManager.emit(event);
    if (event.type === "tool.done" && event.data.ok === true) {
      const toolName = event.data.name as string | undefined;
      if (toolName) {
        const sepIndex = toolName.indexOf("__");
        const server = sepIndex !== -1 ? toolName.slice(0, sepIndex) : toolName;
        const tool = sepIndex !== -1 ? toolName.slice(sepIndex + 2) : toolName;
        // Only emit data.changed for bundle (MCP server) tools, not system
        // nb__* tools. System tools don't modify app data, and broadcasting
        // data.changed for them causes iframes to needlessly re-fetch,
        // creating flicker and repeated tool calls during streaming.
        if (server !== "nb") {
          sseManager.broadcast("data.changed", {
            server,
            tool,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  };

  // Resolve identity provider
  let effectiveProvider: IdentityProvider | null = optProvider ?? runtime.getIdentityProvider();
  if (!effectiveProvider) {
    const workDir = runtime.getWorkDir();
    effectiveProvider = new DevIdentityProvider(workDir, runtime.getUserStore());
  }
  const authMode = resolveAuthMode(effectiveProvider);
  const authConfigured = authMode.type !== "dev";

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
    eventSink: runtime.getEventSink(),
    isLocalhost: true, // Updated after Bun.serve starts
    appOrigin: allowedOrigins ? [...allowedOrigins][0] : undefined,
    internalToken,
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
      sseManager.stop();
      conversationEventManager.stop();
      healthMonitor.stop();
      closeAllMcpSessions().catch(() => {});
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
