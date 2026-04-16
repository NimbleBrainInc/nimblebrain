import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  DEFAULT_CSP,
  DEFAULT_HSTS,
  securityHeaders,
} from "../../../src/api/middleware/security-headers.ts";

function createTestApp(options?: Parameters<typeof securityHeaders>[0]) {
  const app = new Hono();
  app.use("*", securityHeaders(options));
  app.get("/test", (c) => c.json({ ok: true }));
  app.post("/test", (c) => c.json({ ok: true }));
  return app;
}

describe("securityHeaders middleware", () => {
  // Env vars leak across modules in Bun; snapshot/restore to keep tests isolated.
  let savedHsts: string | undefined;
  let savedCsp: string | undefined;

  beforeEach(() => {
    savedHsts = process.env.NB_HSTS;
    savedCsp = process.env.NB_CSP;
    delete process.env.NB_HSTS;
    delete process.env.NB_CSP;
  });

  afterEach(() => {
    if (savedHsts === undefined) delete process.env.NB_HSTS;
    else process.env.NB_HSTS = savedHsts;
    if (savedCsp === undefined) delete process.env.NB_CSP;
    else process.env.NB_CSP = savedCsp;
  });

  test("sets X-Content-Type-Options: nosniff on all responses", async () => {
    const res = await createTestApp().request("/test");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("sets X-Frame-Options: DENY", async () => {
    const res = await createTestApp().request("/test");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("sets Referrer-Policy: strict-origin-when-cross-origin", async () => {
    const res = await createTestApp().request("/test");
    expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  });

  test("sets X-XSS-Protection: 0", async () => {
    const res = await createTestApp().request("/test");
    expect(res.headers.get("X-XSS-Protection")).toBe("0");
  });

  test("sets Permissions-Policy", async () => {
    const res = await createTestApp().request("/test");
    expect(res.headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  test("sets HSTS and CSP defaults for direct-exposure deployments", async () => {
    const res = await createTestApp().request("/test");
    expect(res.headers.get("Strict-Transport-Security")).toBe(DEFAULT_HSTS);
    expect(res.headers.get("Content-Security-Policy")).toBe(DEFAULT_CSP);
  });

  test("option overrides default HSTS/CSP", async () => {
    const res = await createTestApp({
      hsts: "max-age=60",
      csp: "default-src 'self'",
    }).request("/test");
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=60");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
  });

  test("empty-string option disables HSTS/CSP (delegates to reverse proxy)", async () => {
    const res = await createTestApp({ hsts: "", csp: "" }).request("/test");
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  test("NB_HSTS env var overrides option", async () => {
    process.env.NB_HSTS = "max-age=42";
    const res = await createTestApp({ hsts: "max-age=60" }).request("/test");
    expect(res.headers.get("Strict-Transport-Security")).toBe("max-age=42");
  });

  test("NB_CSP env var overrides option", async () => {
    process.env.NB_CSP = "default-src https:";
    const res = await createTestApp({ csp: "default-src 'self'" }).request("/test");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src https:");
  });

  test("NB_HSTS='' env var disables HSTS even when option is set", async () => {
    process.env.NB_HSTS = "";
    const res = await createTestApp({ hsts: "max-age=60" }).request("/test");
    expect(res.headers.get("Strict-Transport-Security")).toBeNull();
  });

  test("sets headers on POST responses too", async () => {
    const res = await createTestApp().request("/test", { method: "POST" });
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Strict-Transport-Security")).toBe(DEFAULT_HSTS);
  });

  test("sets headers on 404 responses", async () => {
    const res = await createTestApp().request("/nonexistent");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Content-Security-Policy")).toBe(DEFAULT_CSP);
  });
});
