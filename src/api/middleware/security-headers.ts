import { createMiddleware } from "hono/factory";

/**
 * Security headers middleware.
 * Sets standard browser security headers on every response.
 * Does NOT set HSTS or CSP — those belong on the reverse proxy.
 */
export function securityHeaders() {
  return createMiddleware(async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    c.res.headers.set("X-XSS-Protection", "0");
    c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });
}
