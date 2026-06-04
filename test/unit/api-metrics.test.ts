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

  it("clamps non-standard HTTP methods to OTHER", async () => {
    const app = new Hono();
    app.use("*", metricsMiddleware());
    app.route("/", metricsRoutes());
    app.all("/v1/any", (c) => c.json({ ok: true }));

    await app.request("/v1/any", { method: "PROPFIND" });
    const body = await (await app.request("/metrics")).text();
    expect(body).toMatch(/http_requests_total\{[^}]*method="OTHER"[^}]*route="\/v1\/any"[^}]*\} [1-9]/);
  });

  // Load-bearing: the whole point of this endpoint is to feed error-rate
  // alerting. A thrown handler must still be counted as status="500" — this
  // relies on Hono's compose catching the throw (via app.onError) so the
  // middleware's `await next()` resolves rather than re-throwing. Lock it in so
  // a refactor that wraps next() in try/catch can't silently kill 500-counting.
  it("counts thrown errors as status 500", async () => {
    const app = new Hono();
    app.use("*", metricsMiddleware());
    app.route("/", metricsRoutes());
    app.onError((_err, c) => c.json({ error: "boom" }, 500));
    app.get("/v1/boom", () => {
      throw new Error("boom");
    });

    const res = await app.request("/v1/boom");
    expect(res.status).toBe(500);

    const body = await (await app.request("/metrics")).text();
    expect(body).toMatch(
      /http_requests_total\{[^}]*route="\/v1\/boom"[^}]*status="500"[^}]*\} [1-9]/,
    );
    // duration histogram observed the errored request too
    expect(body).toMatch(
      /http_request_duration_seconds_count\{[^}]*route="\/v1\/boom"[^}]*status="500"[^}]*\} [1-9]/,
    );
  });
});
