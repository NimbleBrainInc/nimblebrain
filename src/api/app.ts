import { Hono } from "hono";
import { WorkspaceResolutionError } from "./auth-middleware.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { authRoutes } from "./routes/auth.ts";
import { bootstrapRoutes } from "./routes/bootstrap.ts";
import { chatRoutes } from "./routes/chat.ts";
import { composioAuthRoutes } from "./routes/composio-auth.ts";
import { conversationEventRoutes } from "./routes/conversation-events.ts";
import { eventRoutes } from "./routes/events.ts";
import { healthRoutes } from "./routes/health.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { mcpAuthRoutes } from "./routes/mcp-auth.ts";
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
  // Outbound-OAuth callback for remote MCP servers. Unauthenticated by
  // design — state param guards against unsolicited codes. Must be
  // reachable before any authenticated middleware; ordering alongside
  // authRoutes keeps that invariant obvious.
  app.route("/", mcpAuthRoutes(ctx));
  // Composio-backed connectors. Parallel to mcpAuthRoutes — same
  // unauthenticated-callback constraint applies. The /proxy endpoint
  // is the white-label forwarder vendors call back to.
  app.route("/", composioAuthRoutes(ctx));

  // MCP routes BEFORE other authenticated routes — prevents other sub-app
  // wildcard middleware from intercepting /mcp requests. Hono runs use("*")
  // middleware from ALL sub-apps mounted at "/" that appear before the
  // matching route, so MCP must be registered before chat/tools/events.
  app.route("/", mcpRoutes(ctx));

  // Conversation events SSE — Stage 1 Task 005 dropped the workspace
  // requirement on this route (conversations live at the user level
  // post-collapse). Must register BEFORE chat/tools/etc. so their
  // `requireWorkspace` `use("*")` middleware doesn't 400 us on a
  // path that intentionally has no X-Workspace-Id header.
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
    if (err instanceof WorkspaceResolutionError) {
      return apiError(err.statusCode, "workspace_error", err.message);
    }
    console.error("[nimblebrain] Unhandled error:", err);
    return apiError(500, "internal_error", "Internal server error");
  });

  return app;
}
