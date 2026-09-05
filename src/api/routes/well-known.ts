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

import { Hono } from "hono";
import type { AuthorizationServer } from "../../identity/provider.ts";
import type { AppContext } from "../types.ts";

export function wellKnownRoutes(ctx: AppContext) {
  const app = new Hono();

  /**
   * Protected Resource Metadata (RFC 9728).
   *
   * MCP clients fetch this after receiving a 401 whose WWW-Authenticate header
   * carries a resource_metadata URL. It names the authorization server to use.
   */
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const authServer = authorizationServer(ctx);
    if (!authServer) {
      return c.json({ error: "MCP OAuth not configured" }, 404);
    }

    const origin = deriveResourceOrigin(c.req.raw);
    return c.json({
      resource: origin,
      authorization_servers: [authServer.issuer],
      bearer_methods_supported: ["header"],
    });
  });

  /**
   * Authorization Server Metadata proxy (RFC 8414).
   *
   * Older MCP clients that don't support Protected Resource Metadata look for
   * this endpoint instead. We proxy the issuer's own metadata document so the
   * client can discover authorization/token/registration endpoints.
   */
  app.get("/.well-known/oauth-authorization-server", async (c) => {
    const metadataUrl = authorizationServer(ctx)?.metadataUrl;
    if (!metadataUrl) {
      return c.json({ error: "MCP OAuth not configured" }, 404);
    }

    try {
      const upstream = await fetch(metadataUrl);
      if (!upstream.ok) {
        return c.json({ error: "Failed to fetch upstream metadata" }, 502);
      }
      const metadata = await upstream.json();
      return c.json(metadata);
    } catch {
      return c.json({ error: "Failed to fetch upstream metadata" }, 502);
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

/**
 * Derive the resource origin from the incoming request.
 *
 * Honors `X-Forwarded-Proto` so the advertised resource matches the
 * public scheme used by the client, not the internal HTTP connection
 * seen by the pod behind a TLS-terminating proxy (ALB, Caddy, etc.).
 * Without this, `resource` is `http://` and OAuth resource validation
 * fails in clients that connect via `https://`.
 *
 * Host comes from `req.url.host` (the Host header), which ALB/Caddy
 * forward verbatim from the client. We deliberately do NOT honor
 * `X-Forwarded-Host`: AWS ALB rewrites `X-Forwarded-Proto` based on
 * the actual client connection, but nothing similarly sanitizes
 * `X-Forwarded-Host` in our proxy chain, and we don't need it.
 */
function deriveResourceOrigin(req: Request): string {
  const url = new URL(req.url);
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(/:$/, "");
  return `${proto}://${url.host}`;
}
