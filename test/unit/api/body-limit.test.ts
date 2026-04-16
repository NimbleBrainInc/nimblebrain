import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { bodyLimit } from "../../../src/api/middleware/body-limit.ts";

function createTestApp(maxBytes = 1024) {
  const app = new Hono();
  app.use("*", bodyLimit(maxBytes));
  app.post("/test", (c) => c.json({ ok: true }));
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

describe("bodyLimit middleware", () => {
  test("rejects request with Content-Length exceeding limit", async () => {
    const app = createTestApp(1024);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": "2048" },
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("payload_too_large");
    expect(body.message).toBe("Payload too large");
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
});
