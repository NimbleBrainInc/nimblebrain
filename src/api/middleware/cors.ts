import { createMiddleware } from "hono/factory";

const STATIC_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Last-Event-ID, Mcp-Protocol-Version, Mcp-Method, Mcp-Name",
  "Access-Control-Expose-Headers": "Mcp-Protocol-Version",
};

/**
 * CORS middleware, the same under every identity provider:
 * - ALLOWED_ORIGINS set: origin allowlist with credentials
 * - ALLOWED_ORIGINS unset: same-origin only (no header)
 */
export function corsMiddleware(allowedOrigins: Set<string> | null) {
  return createMiddleware(async (c, next) => {
    // CORS preflight
    if (c.req.method === "OPTIONS") {
      const res = new Response(null, { status: 204 });
      for (const [k, v] of Object.entries(buildCorsHeaders(c.req.raw, allowedOrigins))) {
        res.headers.set(k, v);
      }
      return res;
    }

    await next();

    // Apply CORS headers to all responses
    for (const [k, v] of Object.entries(buildCorsHeaders(c.req.raw, allowedOrigins))) {
      c.res.headers.set(k, v);
    }
  });
}

function buildCorsHeaders(
  request: Request,
  allowedOrigins: Set<string> | null,
): Record<string, string> {
  const hdrs = { ...STATIC_CORS_HEADERS };
  const origin = request.headers.get("origin");
  if (origin && allowedOrigins?.has(origin)) {
    hdrs["Access-Control-Allow-Origin"] = origin;
    hdrs["Access-Control-Allow-Credentials"] = "true";
    hdrs.Vary = "Origin";
  }
  // No allowedOrigins → same-origin only (no header set)
  return hdrs;
}
