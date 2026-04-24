import { createMiddleware } from "hono/factory";

const STATIC_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Mcp-Session-Id, Last-Event-ID, Mcp-Protocol-Version, X-Workspace-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Mcp-Protocol-Version",
};

/**
 * CORS middleware. Matches current server.ts behavior:
 * - Dev mode (no auth): Access-Control-Allow-Origin: *
 * - Auth + ALLOWED_ORIGINS: origin whitelist with credentials
 * - Auth + no ALLOWED_ORIGINS: same-origin only (no header)
 */
export function corsMiddleware(authConfigured: boolean, allowedOrigins: Set<string> | null) {
  return createMiddleware(async (c, next) => {
    // CORS preflight
    if (c.req.method === "OPTIONS") {
      const res = new Response(null, { status: 204 });
      for (const [k, v] of Object.entries(
        buildCorsHeaders(c.req.raw, authConfigured, allowedOrigins),
      )) {
        res.headers.set(k, v);
      }
      return res;
    }

    await next();

    // Apply CORS headers to all responses
    for (const [k, v] of Object.entries(
      buildCorsHeaders(c.req.raw, authConfigured, allowedOrigins),
    )) {
      c.res.headers.set(k, v);
    }
  });
}

function buildCorsHeaders(
  request: Request,
  authConfigured: boolean,
  allowedOrigins: Set<string> | null,
): Record<string, string> {
  const hdrs = { ...STATIC_CORS_HEADERS };
  if (!authConfigured) {
    hdrs["Access-Control-Allow-Origin"] = "*";
    return hdrs;
  }
  const origin = request.headers.get("origin");
  if (origin && allowedOrigins?.has(origin)) {
    hdrs["Access-Control-Allow-Origin"] = origin;
    hdrs["Access-Control-Allow-Credentials"] = "true";
    hdrs.Vary = "Origin";
  }
  // No allowedOrigins → same-origin only (no header set)
  return hdrs;
}
