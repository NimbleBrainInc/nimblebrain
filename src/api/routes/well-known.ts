/**
 * OAuth 2.0 discovery endpoints for MCP client interoperability.
 *
 * These endpoints let MCP clients (Claude Desktop, Cursor, etc.) discover the
 * authorization server behind this instance — whichever one the configured
 * identity provider declares — and then run the OAuth flow automatically, with
 * no API keys. A provider that is not an authorization server serves 404 here.
 *
 * Spec references:
 * - RFC 9728: OAuth 2.0 Protected Resource Metadata
 * - RFC 8414: OAuth 2.0 Authorization Server Metadata
 */

import { type Handler, Hono } from "hono";
import type { AuthorizationServer } from "../../identity/provider.ts";
import {
  MCP_PATH_PREFIX,
  mcpResourceUrl,
  PROTECTED_RESOURCE_METADATA_PATH,
} from "../mcp-resource.ts";
import type {
  AuthorizationServerMetadata,
  ProtectedResourceMetadata,
  WellKnownErrorBody,
} from "../schemas/responses.ts";
import { type AppContext, json } from "../types.ts";
import { isWorkspaceIdShape } from "../workspace-address.ts";

export function wellKnownRoutes(ctx: AppContext) {
  const app = new Hono();

  /**
   * Protected Resource Metadata (RFC 9728), one document per workspace.
   *
   * Each workspace's MCP endpoint `/mcp/<wsId>` is its own protected resource,
   * so its document lives at the RFC 9728 §3.1 path for that URL. A 401 from
   * `/mcp/<wsId>` points here, and the client asks the authorization server
   * for a token bound to the `resource` it reads. That `resource` is the
   * canonical URL, built from the configured public origin, never the
   * request's host.
   *
   * Served before authentication, so it answers for any well-formed id
   * without looking the workspace up: its existence is not disclosed here.
   */
  app.get(`${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH_PREFIX}/:wsId`, (c) => {
    const authServer = authorizationServer(ctx);
    if (!authServer) {
      return json<WellKnownErrorBody>({ error: "MCP OAuth not configured" }, 404);
    }
    const wsId = c.req.param("wsId");
    if (!isWorkspaceIdShape(wsId)) {
      return json<WellKnownErrorBody>({ error: "not_found" }, 404);
    }
    return json<ProtectedResourceMetadata>({
      resource: mcpResourceUrl(wsId),
      authorization_servers: [authServer.issuer],
      bearer_methods_supported: ["header"],
    });
  });

  /**
   * The root document would describe the origin as a protected resource, and
   * nothing at the origin accepts a token minted for it: bare `/mcp` is refused
   * and `/v1/*` takes no resource token. Advertising it would send a client to
   * mint a token every route refuses, so it is absent, and says where to look.
   *
   * The same holds for every other path under the metadata path, bare `/mcp`
   * included: only `/mcp/<wsId>` is a resource. They are answered here, where
   * the request is still unauthenticated, so none falls through to an
   * authenticated route's middleware and reads as a 401.
   */
  const noResource: Handler = () =>
    json<WellKnownErrorBody>(
      {
        error: "not_found",
        message: `Each workspace's MCP endpoint is its own resource; its metadata is at ${PROTECTED_RESOURCE_METADATA_PATH}${MCP_PATH_PREFIX}/<workspaceId>.`,
      },
      404,
    );
  app.get(PROTECTED_RESOURCE_METADATA_PATH, noResource);
  app.get(`${PROTECTED_RESOURCE_METADATA_PATH}/*`, noResource);

  /**
   * Authorization Server Metadata proxy (RFC 8414).
   *
   * Older MCP clients that don't support Protected Resource Metadata look for
   * this endpoint instead. We proxy the issuer's own metadata document so the
   * client can discover authorization/token/registration endpoints.
   */
  app.get("/.well-known/oauth-authorization-server", async () => {
    const metadataUrl = authorizationServer(ctx)?.metadataUrl;
    if (!metadataUrl) {
      return json<WellKnownErrorBody>({ error: "MCP OAuth not configured" }, 404);
    }

    try {
      const upstream = await fetch(metadataUrl);
      if (!upstream.ok) {
        return json<WellKnownErrorBody>({ error: "Failed to fetch upstream metadata" }, 502);
      }
      const metadata = (await upstream.json()) as AuthorizationServerMetadata;
      return json<AuthorizationServerMetadata>(metadata);
    } catch {
      return json<WellKnownErrorBody>({ error: "Failed to fetch upstream metadata" }, 502);
    }
  });

  return app;
}

/** The authorization server this instance's provider declares, if it is one. */
function authorizationServer(ctx: AppContext): AuthorizationServer | null {
  const provider = ctx.provider;
  if (!provider?.capabilities.authorizationServer) return null;
  return provider.authorizationServer?.() ?? null;
}
