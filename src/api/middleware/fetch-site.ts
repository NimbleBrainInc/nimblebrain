import { createMiddleware } from "hono/factory";
import { apiError } from "../types.ts";

/** Methods that only read. A browser may send any of them cross-site. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Refuse a write a browser sent from another origin, unless that origin is an
 * allowed CORS origin.
 *
 * The session cookie is `SameSite=Lax`, which stops a cross-SITE form post but
 * not one from another origin on the same site. A form or `text/plain` POST
 * needs no CORS preflight, so it would reach the handler carrying the cookie.
 * The browser's `Sec-Fetch-Site` header says where the request came from:
 * `same-origin` and `none` (typed or bookmarked) pass; `same-site` and
 * `cross-site` pass only from an origin the CORS allowlist names. A request
 * without the header is not from a browser that attaches cookies on its own.
 */
export function rejectCrossSiteWrites(allowedOrigins: Set<string> | null) {
  return createMiddleware(async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const site = c.req.header("sec-fetch-site");
    if (site === "same-site" || site === "cross-site") {
      const origin = c.req.header("origin");
      if (!origin || !allowedOrigins?.has(origin)) {
        return apiError(403, "cross_site_request", "Cross-site request refused");
      }
    }
    return next();
  });
}
