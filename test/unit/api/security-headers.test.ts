import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { securityHeaders } from "../../../src/api/middleware/security-headers.ts";

function createTestApp() {
  const app = new Hono();
  app.use("*", securityHeaders());
  app.get("/test", (c) => c.json({ ok: true }));
  app.post("/test", (c) => c.json({ ok: true }));
  return app;
}

describe("securityHeaders middleware", () => {
  const app = createTestApp();

  test("sets X-Content-Type-Options: nosniff on all responses", async () => {
    const res = await app.request("/test");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("sets X-Frame-Options: DENY", async () => {
    const res = await app.request("/test");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("sets Referrer-Policy: strict-origin-when-cross-origin", async () => {
    const res = await app.request("/test");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  test("sets X-XSS-Protection: 0", async () => {
    const res = await app.request("/test");
    expect(res.headers.get("X-XSS-Protection")).toBe("0");
  });

  test("sets Permissions-Policy", async () => {
    const res = await app.request("/test");
    expect(res.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  test("does not set HSTS or CSP", async () => {
    const res = await app.request("/test");
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  test("sets headers on POST responses too", async () => {
    const res = await app.request("/test", { method: "POST" });
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("sets headers on 404 responses", async () => {
    const res = await app.request("/nonexistent");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
