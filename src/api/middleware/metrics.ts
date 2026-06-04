import { createMiddleware } from "hono/factory";
import { httpRequestDurationSeconds, httpRequestsTotal } from "../metrics.ts";

// HTTP method is the one label sourced from the raw request. The verb set is
// effectively fixed, but the HTTP grammar allows arbitrary method tokens, and
// this middleware runs before auth — so a client could otherwise inflate
// `method` cardinality. Clamp to the standard verbs; bucket anything else.
const STANDARD_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

/**
 * Records request count and duration for every request into the Prometheus
 * registry. Registered first so it times the full handler chain.
 *
 * The `route` label is the matched route pattern (`c.req.routePath`), not the
 * raw path, to keep label cardinality bounded. The `/metrics` scrape itself is
 * skipped so it doesn't pollute the histogram or count Prometheus' own polling.
 *
 * Streaming responses (SSE: /v1/events, conversation-events) do NOT skew the
 * latency histogram: next() resolves when the streaming Response is returned,
 * not when the stream closes, so this records time-to-first-byte. Verified — a
 * stream held open 300ms records ~1ms here, not 300ms.
 */
export function metricsMiddleware() {
  return createMiddleware(async (c, next) => {
    if (c.req.path === "/metrics") {
      return next();
    }
    const start = performance.now();
    await next();
    const seconds = (performance.now() - start) / 1000;
    const labels = {
      method: STANDARD_METHODS.has(c.req.method) ? c.req.method : "OTHER",
      route: c.req.routePath || "unmatched",
      status: String(c.res.status),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, seconds);
  });
}
