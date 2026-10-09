import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { TokenGrant } from "../../identity/provider.ts";
import { publicOrigin } from "../../oauth/public-origin.ts";
import { authenticateRequest, isAuthError } from "../auth-middleware.ts";
import { MCP_PATH_PREFIX, mcpResourceMetadataUrl, mcpResourceUrl } from "../mcp-resource.ts";
import type { McpRequestContext } from "../mcp-server.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { requestRateLimit } from "../middleware/rate-limit.ts";
import type { JsonRpcErrorBody } from "../schemas/responses.ts";
import { type AppContext, type AuthEnv, apiError, json } from "../types.ts";
import { isAddressedWorkspaceMember, isWorkspaceIdShape } from "../workspace-address.ts";

/**
 * Build the WWW-Authenticate header value for MCP OAuth discovery.
 *
 * When an MCP client receives this header on a 401, it fetches the
 * resource_metadata URL to discover the authorization server and initiates
 * the OAuth flow for the resource that document names. It must be the
 * workspace's own document: the root one names no resource this server
 * accepts tokens for.
 */
function mcpWwwAuthenticate(wsId: string): string {
  return [
    'Bearer error="unauthorized"',
    'error_description="Authorization required"',
    `resource_metadata="${mcpResourceMetadataUrl(wsId)}"`,
  ].join(", ");
}

/** Whether this instance has an authorization server for MCP clients to discover. */
function hasMcpOAuth(ctx: AppContext): boolean {
  const provider = ctx.provider;
  if (!provider?.capabilities.authorizationServer) return false;
  return provider.authorizationServer?.() != null;
}

/** A JSON-RPC error envelope, the shape an MCP client reports to its user. */
function mcpError(status: number, message: string): Response {
  return json<JsonRpcErrorBody>(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    status,
  );
}

/** `AuthEnv` plus the grant the caller's credential carries, set by {@link requireMcpAuth}. */
type McpAuthEnv = { Variables: AuthEnv["Variables"] & { grant: TokenGrant } };

/**
 * The one answer for a workspace this caller cannot reach: malformed, unknown,
 * or not theirs. Identical in every case, so it says nothing about which
 * workspaces exist.
 */
function workspaceNotFound(): Response {
  return mcpError(404, "Workspace not found");
}

/**
 * MCP-specific auth middleware for `/mcp/:wsId`.
 *
 * Authenticates against the workspace's canonical resource URL, so a token
 * from the MCP authorization server is admitted only when minted for exactly
 * this URL (`grantAdmits`). A 401 carries the workspace's resource metadata
 * URL so the client can discover the authorization server and obtain one.
 */
function requireMcpAuth(ctx: AppContext) {
  return createMiddleware<McpAuthEnv>(async (c, next) => {
    const wsId = c.req.param("wsId") ?? "";
    // Shape only — answered before authentication, and says nothing about
    // whether the workspace exists.
    if (!isWorkspaceIdShape(wsId)) return workspaceNotFound();

    const result = await authenticateRequest(c.req.raw, ctx.authOptions, mcpResourceUrl(wsId));

    if (isAuthError(result)) {
      if (result.status === 401 && hasMcpOAuth(ctx)) {
        return apiError(401, "unauthorized", "Authentication required for MCP", undefined, {
          "WWW-Authenticate": mcpWwwAuthenticate(wsId),
        });
      }
      return result;
    }

    if (result.identity) {
      c.set("identity", result.identity);
      c.set("grant", result.grant);
    }
    await next();
  });
}

/**
 * Bare `/mcp` names no workspace, and no workspace is chosen for it. 404, not
 * 401: a 401 would send a client into an OAuth flow for a resource that does
 * not exist, and there is no metadata document to point it at.
 */
function bareMcpRefused(): Response {
  return mcpError(
    404,
    `This MCP endpoint is per workspace. Connect to ${publicOrigin()}${MCP_PATH_PREFIX}/<workspaceId> ` +
      "(Workspace settings → MCP shows the URL).",
  );
}

export function mcpRoutes(ctx: AppContext) {
  const app = new Hono<McpAuthEnv>();

  app.all(MCP_PATH_PREFIX, bareMcpRefused);
  app.all(`${MCP_PATH_PREFIX}/`, bareMcpRefused);

  // Rate limit the remote surface: external MCP clients + sandboxed connector
  // iframes (the bridge speaks `/mcp`). It runs after `requireMcpAuth`, so the
  // identity and grant are populated. The bucket is per identity AND grant
  // kind: the web shell's bridge (first-party session) and an external client
  // signed in as the same user (resource token) are different callers, and one
  // spending the whole budget must not refuse the other. Where a provider marks
  // an external caller first-party (OIDC bearers, an operator-listed AuthKit
  // client), that caller shares the shell's bucket.
  app.all(
    `${MCP_PATH_PREFIX}/:wsId`,
    requireMcpAuth(ctx),
    requestRateLimit<McpAuthEnv>(
      ctx.mcpLimiter,
      (c) => `${c.var.identity?.id ?? "anon"}:${c.var.grant?.kind ?? "none"}`,
    ),
    bodyLimit(1_048_576),
    async (c) => {
      const features = ctx.runtime.getFeatures();
      const wsId = c.req.param("wsId");

      const identity = c.var.identity;
      if (!identity || !ctx.workspaceStore) {
        return apiError(
          401,
          "unauthorized",
          "Authentication required for MCP",
          undefined,
          hasMcpOAuth(ctx) ? { "WWW-Authenticate": mcpWwwAuthenticate(wsId) } : undefined,
        );
      }

      // Membership authorizes; the token's audience only proved it was minted
      // for this URL. Checked on every request, fail-closed, and a non-member
      // gets exactly the unknown-workspace answer.
      if (!(await isAddressedWorkspaceMember(ctx.workspaceStore, wsId, identity.id))) {
        return workspaceNotFound();
      }

      const requestCtx: McpRequestContext = {
        identity,
        workspaceId: wsId,
        grant: c.var.grant.kind,
      };
      return ctx.mcpHost.handle(c.req.raw, features, requestCtx);
    },
  );

  return app;
}
