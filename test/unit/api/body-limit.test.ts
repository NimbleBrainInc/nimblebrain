import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { BodyLimitOptions } from "../../../src/api/middleware/body-limit.ts";
import { bodyLimit } from "../../../src/api/middleware/body-limit.ts";

function createTestApp(maxBytes = 1024, opts?: BodyLimitOptions) {
  const app = new Hono();
  app.use("*", bodyLimit(maxBytes, opts));
  app.post("/test", (c) => c.json({ ok: true }));
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

describe("bodyLimit middleware", () => {
  test("rejects request with Content-Length exceeding limit", async () => {
    const app = createTestApp(1024);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": "2048", "Content-Type": "application/json" },
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("payload_too_large");
    expect(body.message).toBe("Payload too large");
  });

  test("413 body includes limit, received, and contentType", async () => {
    const app = createTestApp(1024);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": "4096", "Content-Type": "application/json" },
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.details).toEqual({
      limit: 1024,
      received: 4096,
      contentType: "application/json",
    });
  });

  test("allows request within limit", async () => {
    const app = createTestApp(1024);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": "512" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("allows request with no Content-Length header", async () => {
    const app = createTestApp(1024);
    const res = await app.request("/test", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("allows GET requests regardless of Content-Length", async () => {
    const app = createTestApp(1024);
    const res = await app.request("/test", {
      method: "GET",
      headers: { "Content-Length": "2048" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("multipart uploads use the multipart limit, not the base limit", async () => {
    const app = createTestApp(1024, { multipart: 10 * 1024 });
    const res = await app.request("/test", {
      method: "POST",
      headers: {
        "Content-Length": "8192",
        "Content-Type": "multipart/form-data; boundary=abc",
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("multipart uploads over the multipart limit are rejected", async () => {
    const app = createTestApp(1024, { multipart: 4096 });
    const res = await app.request("/test", {
      method: "POST",
      headers: {
        "Content-Length": "8192",
        "Content-Type": "multipart/form-data; boundary=abc",
      },
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.details?.limit).toBe(4096);
    expect(body.details?.received).toBe(8192);
    expect(body.details?.contentType).toContain("multipart/form-data");
  });

  test("non-multipart content-types stay bounded by the base limit even when multipart is set", async () => {
    const app = createTestApp(1024, { multipart: 10 * 1024 });
    const res = await app.request("/test", {
      method: "POST",
      headers: {
        "Content-Length": "2048",
        "Content-Type": "application/json",
      },
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.details?.limit).toBe(1024);
  });

  test("multipart matching is case-insensitive on content-type", async () => {
    const app = createTestApp(1024, { multipart: 10 * 1024 });
    const res = await app.request("/test", {
      method: "POST",
      headers: {
        "Content-Length": "8192",
        "Content-Type": "MULTIPART/FORM-DATA; boundary=abc",
      },
    });
    expect(res.status).toBe(200);
  });
});
