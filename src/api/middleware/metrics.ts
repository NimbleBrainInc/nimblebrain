import { createMiddleware } from "hono/factory";
import { httpRequestDurationSeconds, httpRequestsTotal } from "../metrics.ts";

/**
 * Records request count and duration for every request into the Prometheus
 * registry. Registered first so it times the full handler chain.
 *
 * The `route` label is the matched route pattern (`c.req.routePath`), not the
 * raw path, to keep label cardinality bounded. The `/metrics` scrape itself is
 * skipped so it doesn't pollute the histogram or count Prometheus' own polling.
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
      method: c.req.method,
      route: c.req.routePath || "unmatched",
      status: String(c.res.status),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, seconds);
  });
}
