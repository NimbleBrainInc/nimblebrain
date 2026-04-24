/**
 * OAuth 2.0 discovery endpoints for MCP client interoperability.
 *
 * These endpoints allow MCP clients (Claude Desktop, Cursor, etc.) to
 * discover that NimbleBrain uses WorkOS AuthKit as its authorization server,
 * then perform the OAuth flow automatically — no API keys needed.
 *
 * Spec references:
 * - RFC 9728: OAuth 2.0 Protected Resource Metadata
 * - RFC 8414: OAuth 2.0 Authorization Server Metadata
 */

import { Hono } from "hono";
import type { WorkosIdentityProvider } from "../../identity/providers/workos.ts";
import type { AppContext } from "../types.ts";

export function wellKnownRoutes(ctx: AppContext) {
  const app = new Hono();

  /**
   * Protected Resource Metadata (RFC 9728).
   *
   * MCP clients fetch this after receiving a 401 with a WWW-Authenticate
   * header containing a resource_metadata URL. It tells them which
   * authorization server to use (AuthKit).
   */
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const authkitDomain = getAuthkitDomain(ctx);
    if (!authkitDomain) {
      return c.json({ error: "MCP OAuth not configured" }, 404);
    }

    const origin = deriveResourceOrigin(c.req.raw);
    return c.json({
      resource: origin,
      authorization_servers: [`https://${authkitDomain}.authkit.app`],
      bearer_methods_supported: ["header"],
    });
  });

  /**
   * Authorization Server Metadata proxy (RFC 8414).
   *
   * Older MCP clients that don't support Protected Resource Metadata
   * look for this endpoint instead. We proxy it from AuthKit so the
   * client can discover authorization/token/registration endpoints.
   */
  app.get("/.well-known/oauth-authorization-server", async (c) => {
    const authkitDomain = getAuthkitDomain(ctx);
    if (!authkitDomain) {
      return c.json({ error: "MCP OAuth not configured" }, 404);
    }

    try {
      const upstream = await fetch(
        `https://${authkitDomain}.authkit.app/.well-known/oauth-authorization-server`,
      );
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

/** Extract the AuthKit domain from the WorkOS provider, if configured. */
function getAuthkitDomain(ctx: AppContext): string | null {
  const provider = ctx.provider;
  if (provider && "getAuthkitDomain" in provider) {
    return (provider as WorkosIdentityProvider).getAuthkitDomain() ?? null;
  }
  return null;
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
