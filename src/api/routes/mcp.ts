import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { WorkosIdentityProvider } from "../../identity/providers/workos.ts";
import {
  type AuthMiddlewareOptions,
  authenticateRequest,
  isAuthError,
} from "../auth-middleware.ts";
import type { McpSessionContext } from "../mcp-server.ts";
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
  // Honor X-Forwarded-Proto from the ALB (which rewrites it based on the
  // actual client→ALB connection). Host comes from the Host header via
  // url.host; we deliberately do NOT honor X-Forwarded-Host.
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(/:$/, "");
  const origin = `${proto}://${url.host}`;
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

    // Stage 2: `/mcp` sessions are identity-bound only. The `X-Workspace-Id`
    // header is no longer consulted here — the host logs once at debug
    // (`NB_DEBUG=mcp`) if a client still sends one. Tool calls derive their
    // target workspace from the namespaced tool name on every call (parsed
    // and routed by the orchestrator).
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

    const sessionCtx: McpSessionContext = { identity };
    return ctx.mcpHost.handle(c.req.raw, features, sessionCtx);
  });

  return app;
}
