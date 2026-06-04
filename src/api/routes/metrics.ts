import { Hono } from "hono";
import { metricsRegistry } from "../metrics.ts";

/**
 * GET /metrics — Prometheus exposition endpoint.
 *
 * Bare path (not under /v1) so the web Caddy proxy does not forward it
 * publicly; scraped in-cluster by the ServiceMonitor. Unauthenticated like
 * /v1/health — it carries no per-user data and is only reachable inside the
 * cluster.
 */
export function metricsRoutes() {
  return new Hono().get("/metrics", async (c) => {
    const body = await metricsRegistry.metrics();
    return c.body(body, 200, { "Content-Type": metricsRegistry.contentType });
  });
}
