import { createMiddleware } from "hono/factory";

/**
 * Default HSTS: 1-year, applies to subdomains. No `preload` — opting into the
 * preload list is a deliberate operator choice.
 */
export const DEFAULT_HSTS = "max-age=31536000; includeSubDomains";

/**
 * Default CSP: locks the API down to nothing. JSON and SSE responses are
 * unaffected. Bundle UI HTML served from /v1/apps/... is consumed by the
 * iframe bridge via fetch + srcdoc (where the response CSP does not apply),
 * so a restrictive header actively protects against someone opening that
 * HTML directly in a browser.
 */
export const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export interface SecurityHeadersOptions {
  /**
   * Strict-Transport-Security value. `undefined` uses the default, empty
   * string disables the header. `NB_HSTS` env var takes precedence.
   */
  hsts?: string;
  /**
   * Content-Security-Policy value. `undefined` uses the default, empty string
   * disables the header. `NB_CSP` env var takes precedence.
   */
  csp?: string;
}

/**
 * Security headers middleware. Sets standard browser security headers on
 * every response.
 *
 * HSTS and CSP are included with conservative defaults so direct-exposure
 * self-hosted deployments are not left naked when no reverse proxy sits in
 * front. Operators who terminate TLS at a proxy that already emits these
 * headers can disable them by setting `NB_HSTS=""` / `NB_CSP=""`, or override
 * to a stricter/looser value via env var or option.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}) {
  const hsts = process.env.NB_HSTS ?? options.hsts ?? DEFAULT_HSTS;
  const csp = process.env.NB_CSP ?? options.csp ?? DEFAULT_CSP;
  return createMiddleware(async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    c.res.headers.set("X-XSS-Protection", "0");
    c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (hsts) c.res.headers.set("Strict-Transport-Security", hsts);
    if (csp) c.res.headers.set("Content-Security-Policy", csp);
  });
}
