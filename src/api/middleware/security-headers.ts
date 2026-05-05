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
 *
 * `X-Frame-Options` is set as a *default* (`DENY`) — routes that legitimately
 * serve framed content (e.g., the same-origin http-proxy bundles use to embed
 * their dev servers) override it explicitly to `SAMEORIGIN`. We use `set` only
 * when the route hasn't already provided a value, so route-level intent wins.
 *
 * The proxy route serves iframed bundle dev-server content, where the strict
 * default CSP would block the bundle's own scripts/styles. Such routes set
 * the internal `X-NB-Skip-Security-Defaults` response header to opt out of
 * HSTS/CSP defaults; this middleware strips that header before egress. The
 * parent shell's `frame-ancestors 'none'` is the real protection vector for
 * those responses, not a CSP on the iframe content itself.
 */
export const SKIP_DEFAULTS_HEADER = "X-NB-Skip-Security-Defaults";

export function securityHeaders(options: SecurityHeadersOptions = {}) {
  const hsts = process.env.NB_HSTS ?? options.hsts ?? DEFAULT_HSTS;
  const csp = process.env.NB_CSP ?? options.csp ?? DEFAULT_CSP;
  return createMiddleware(async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    if (!c.res.headers.has("X-Frame-Options")) {
      c.res.headers.set("X-Frame-Options", "DENY");
    }
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    c.res.headers.set("X-XSS-Protection", "0");
    c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    const skipDefaults = c.res.headers.has(SKIP_DEFAULTS_HEADER);
    if (skipDefaults) {
      c.res.headers.delete(SKIP_DEFAULTS_HEADER);
      return;
    }
    if (hsts && !c.res.headers.has("Strict-Transport-Security")) {
      c.res.headers.set("Strict-Transport-Security", hsts);
    }
    if (csp && !c.res.headers.has("Content-Security-Policy")) {
      c.res.headers.set("Content-Security-Policy", csp);
    }
  });
}
