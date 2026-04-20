import { Hono } from "hono";
import { WorkspaceResolutionError } from "./auth-middleware.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { authRoutes } from "./routes/auth.ts";
import { bootstrapRoutes } from "./routes/bootstrap.ts";
import { chatRoutes } from "./routes/chat.ts";
import { conversationEventRoutes } from "./routes/conversation-events.ts";
import { eventRoutes } from "./routes/events.ts";
import { healthRoutes } from "./routes/health.ts";
import { mcpRoutes } from "./routes/mcp.ts";
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

  // Global CORS middleware
  app.use("*", corsMiddleware(authConfigured, allowedOrigins));
  app.use("*", securityHeaders());

  // Route groups — well-known endpoints first (unauthenticated, no body limit needed)
  app.route("/", wellKnownRoutes(ctx));
  app.route("/", healthRoutes(ctx));
  app.route("/", authRoutes(ctx));

  // MCP routes BEFORE other authenticated routes — prevents other sub-app
  // wildcard middleware from intercepting /mcp requests. Hono runs use("*")
  // middleware from ALL sub-apps mounted at "/" that appear before the
  // matching route, so MCP must be registered before chat/tools/events.
  app.route("/", mcpRoutes(ctx));

  app.route("/", bootstrapRoutes(ctx));
  app.route("/", chatRoutes(ctx));
  app.route("/", toolRoutes(ctx));
  app.route("/", resourceRoutes(ctx));
  app.route("/", eventRoutes(ctx));
  app.route("/", conversationEventRoutes(ctx));

  // 404 fallback
  app.notFound(() => apiError(404, "not_found", "Not found"));

  // Centralized error handler
  app.onError((err) => {
    if (err instanceof WorkspaceResolutionError) {
      return apiError(err.statusCode, "workspace_error", err.message);
    }
    console.error("[nimblebrain] Unhandled error:", err);
    return apiError(500, "internal_error", "Internal server error");
  });

  return app;
}
