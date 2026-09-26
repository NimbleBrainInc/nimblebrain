import { Hono } from "hono";
import { log } from "../observability/log.ts";
import { enableDefaultMetrics } from "./metrics.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { rejectCrossSiteWrites } from "./middleware/fetch-site.ts";
import { metricsMiddleware } from "./middleware/metrics.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { tracingMiddleware } from "./middleware/tracing.ts";
import { authRoutes } from "./routes/auth.ts";
import { bootstrapRoutes } from "./routes/bootstrap.ts";
import { chatRoutes } from "./routes/chat.ts";
import { conversationEventRoutes } from "./routes/conversation-events.ts";
import { eventRoutes } from "./routes/events.ts";
import { healthRoutes } from "./routes/health.ts";
import { hooksRoutes } from "./routes/hooks.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { mcpAuthRoutes } from "./routes/mcp-auth.ts";
import { metricsRoutes } from "./routes/metrics.ts";
import { resourceRoutes } from "./routes/resources.ts";
import { toolRoutes } from "./routes/tools.ts";
import { wellKnownRoutes } from "./routes/well-known.ts";
import { type AppContext, apiError } from "./types.ts";

export function createApp(
  ctx: AppContext,
  authConfigured: boolean,
  allowedOrigins: Set<string> | null,
) {
  const app = new Hono();

  // Turn on process/runtime metrics for this server (idempotent).
  enableDefaultMetrics();

  // Tracing outermost so the HTTP span wraps the full chain (incl. metrics) and
  // establishes the trace context every downstream handler/span inherits.
  app.use("*", tracingMiddleware());

  // Request metrics first so it times the full handler chain.
  app.use("*", metricsMiddleware());

  // Global CORS middleware
  app.use("*", corsMiddleware(authConfigured, allowedOrigins));
  app.use("*", securityHeaders());
  // Workspace-scoped writes take the session cookie; refuse a browser's
  // cross-origin write that no CORS preflight would have stopped.
  app.use("/v1/workspaces/*", rejectCrossSiteWrites(allowedOrigins));

  // Route groups — well-known endpoints first (unauthenticated, no body limit needed)
  app.route("/", wellKnownRoutes(ctx));
  app.route("/", healthRoutes());
  // Prometheus scrape endpoint. Bare /metrics (never /v1/metrics) so the web
  // Caddy proxy doesn't expose it publicly; scraped in-cluster only.
  app.route("/", metricsRoutes());
  app.route("/", authRoutes(ctx));
  // Outbound-OAuth callback for remote MCP servers. Unauthenticated by
  // design — state param guards against unsolicited codes. Must be
  // reachable before any authenticated middleware; ordering alongside
  // authRoutes keeps that invariant obvious.
  app.route("/", mcpAuthRoutes(ctx));
  // Managed-connector providers own their HTTP callback surface (Composio's
  // `/v1/composio-auth/*`). Mounted here — parallel to mcpAuthRoutes, same
  // unauthenticated-callback constraint — only for each REGISTERED provider, so
  // a provider-less deploy mounts nothing and 404s at the router (honest "not
  // installed") instead of hitting an internal config gate.
  for (const provider of ctx.runtime.getManagedConnectorRegistry().list()) {
    const providerRoutes = provider.routes?.(ctx);
    if (providerRoutes) app.route("/", providerRoutes);
  }

  // Inbound vendor webhooks. Unauthenticated by design for the same reason the
  // callbacks above are — a vendor's POST cannot carry a platform token — and
  // mounted in this same block so that constraint stays visible in one place.
  // The credential is the sealed capability in the path; everything under
  // `/v1/hooks/` that does not open one 404s. Returns null (mounts nothing)
  // when no hook key is provisioned, so a deployment without the capability
  // answers an honest router 404 rather than an internal config gate.
  const hooks = hooksRoutes(ctx);
  if (hooks) app.route("/", hooks);

  // MCP routes BEFORE other authenticated routes — prevents other sub-app
  // wildcard middleware from intercepting /mcp requests. Hono runs use("*")
  // middleware from ALL sub-apps mounted at "/" that appear before the
  // matching route, so MCP must be registered before chat/tools/events.
  app.route("/", mcpRoutes(ctx));

  // Conversation events SSE — identity-scoped (located by conversation id,
  // owner-gated). Registered before chat/tools/etc. so their `use("*")`
  // middleware does not run on it.
  app.route("/", conversationEventRoutes(ctx));

  app.route("/", bootstrapRoutes(ctx));
  app.route("/", chatRoutes(ctx));
  app.route("/", toolRoutes(ctx));
  app.route("/", resourceRoutes(ctx));
  app.route("/", eventRoutes(ctx));

  // 404 fallback
  app.notFound(() => apiError(404, "not_found", "Not found"));

  // Centralized error handler
  app.onError((err) => {
    log.error("[nimblebrain] Unhandled error", {
      error: err instanceof Error ? err.message : String(err),
    });
    return apiError(500, "internal_error", "Internal server error");
  });

  return app;
}
