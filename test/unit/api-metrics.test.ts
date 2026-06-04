import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { enableDefaultMetrics } from "../../src/api/metrics.ts";
import { metricsMiddleware } from "../../src/api/middleware/metrics.ts";
import { metricsRoutes } from "../../src/api/routes/metrics.ts";

function makeApp() {
  const app = new Hono();
  app.use("*", metricsMiddleware());
  app.route("/", metricsRoutes());
  app.get("/v1/ping", (c) => c.json({ ok: true }));
  return app;
}

describe("api metrics", () => {
  it("serves Prometheus exposition at /metrics", async () => {
    const res = await makeApp().request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("http_requests_total");
    expect(body).toContain("http_request_duration_seconds");
  });

  it("exposes default process metrics once enabled", async () => {
    enableDefaultMetrics();
    const body = await (await makeApp().request("/metrics")).text();
    expect(body).toContain("process_");
  });

  it("counts requests by matched route pattern", async () => {
    const app = makeApp();
    await app.request("/v1/ping");
    const body = await (await app.request("/metrics")).text();
    expect(body).toMatch(/http_requests_total\{[^}]*route="\/v1\/ping"[^}]*\} [1-9]/);
  });

  it("does not count the /metrics scrape itself", async () => {
    const app = makeApp();
    await app.request("/metrics");
    const body = await (await app.request("/metrics")).text();
    expect(body).not.toMatch(/http_requests_total\{[^}]*route="\/metrics"/);
  });
});
