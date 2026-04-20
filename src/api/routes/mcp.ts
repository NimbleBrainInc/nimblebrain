import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { WorkosIdentityProvider } from "../../identity/providers/workos.ts";
import {
  type AuthMiddlewareOptions,
  authenticateRequest,
  isAuthError,
  resolveWorkspace,
  WorkspaceResolutionError,
} from "../auth-middleware.ts";
import { handleMcpRequest, type McpWorkspaceContext } from "../mcp-server.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { type AppContext, type AuthEnv, apiError } from "../types.ts";

/**
 * Build the WWW-Authenticate header value for MCP OAuth discovery.
 *
 * When an MCP client receives this header on a 401, it fetches the
 * resource_metadata URL to discover the AuthKit authorization server
 * and initiates the OAuth flow automatically.
 */
function mcpWwwAuthenticate(req: Request): string {
  const url = new URL(req.url);
  const origin = `${url.protocol}//${url.host}`;
  return [
    'Bearer error="unauthorized"',
    'error_description="Authorization required"',
    `resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  ].join(", ");
}

/** Check if AuthKit MCP OAuth is configured on the provider. */
function hasAuthkitOAuth(ctx: AppContext): boolean {
  return !!(
    ctx.provider &&
    "getAuthkitDomain" in ctx.provider &&
    (ctx.provider as WorkosIdentityProvider).getAuthkitDomain()
  );
}

/**
 * MCP-specific auth middleware.
 *
 * Like requireAuth, but returns WWW-Authenticate header with resource_metadata
 * on 401 so MCP clients can discover the AuthKit authorization server and
 * initiate the OAuth flow automatically.
 */
function requireMcpAuth(options: AuthMiddlewareOptions, ctx: AppContext) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const result = await authenticateRequest(c.req.raw, options);

    if (isAuthError(result)) {
      // Attach WWW-Authenticate header for MCP OAuth discovery
      if (result.status === 401 && hasAuthkitOAuth(ctx)) {
        return apiError(401, "unauthorized", "Authentication required for MCP", undefined, {
          "WWW-Authenticate": mcpWwwAuthenticate(c.req.raw),
        });
      }
      return result;
    }

    if (result.identity) {
      c.set("identity", result.identity);
    }
    await next();
  });
}

export function mcpRoutes(ctx: AppContext) {
  const app = new Hono<AuthEnv>();
  app.use("*", requireMcpAuth(ctx.authOptions, ctx));

  app.all("/mcp", bodyLimit(1_048_576), async (c) => {
    const features = ctx.runtime.getFeatures();
    if (!features.mcpServer) {
      return apiError(404, "not_found", "Not found");
    }

    // Every MCP request must be workspace-scoped
    const identity = c.var.identity;
    if (!identity || !ctx.workspaceStore) {
      return apiError(
        401,
        "unauthorized",
        "Authentication required for MCP",
        undefined,
        hasAuthkitOAuth(ctx) ? { "WWW-Authenticate": mcpWwwAuthenticate(c.req.raw) } : undefined,
      );
    }

    let wsId: string;
    try {
      wsId = await resolveWorkspace(c.req.raw, identity, ctx.workspaceStore);
    } catch (e) {
      if (e instanceof WorkspaceResolutionError) {
        return apiError(e.statusCode, "workspace_error", e.message);
      }
      throw e;
    }

    const registry = await ctx.runtime.ensureWorkspaceRegistry(wsId);
    const mcpWorkspaceCtx: McpWorkspaceContext = {
      registry,
      identity,
      workspaceId: wsId,
    };
    return handleMcpRequest(c.req.raw, registry, features, mcpWorkspaceCtx);
  });

  return app;
}
