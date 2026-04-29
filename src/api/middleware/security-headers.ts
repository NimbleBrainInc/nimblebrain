import { createMiddleware } from "hono/factory";

/**
 * Security headers middleware.
 * Sets standard browser security headers on every response.
 * Does NOT set HSTS or CSP — those belong on the reverse proxy.
 *
 * `X-Frame-Options` is set as a *default* (`DENY`) — routes that legitimately
 * serve framed content (e.g., the same-origin http-proxy bundles use to embed
 * their dev servers) override it explicitly to `SAMEORIGIN`. We use `set` only
 * when the route hasn't already provided a value, so route-level intent wins.
 */
export function securityHeaders() {
  return createMiddleware(async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    if (!c.res.headers.has("X-Frame-Options")) {
      c.res.headers.set("X-Frame-Options", "DENY");
    }
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    c.res.headers.set("X-XSS-Protection", "0");
    c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });
}
