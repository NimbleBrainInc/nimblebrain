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

  // Regression guard: bodyLimit must stay scoped to the route it's attached
  // to. Mounting it via `.use("*")` on a sub-app that is itself mounted at
  // `/` makes it leak across sibling sub-apps — that's how the multipart
  // limit on /v1/chat/stream was silently shadowed by the 1MB JSON limit
  // on another sub-app in an earlier iteration of this fix.
  test("per-handler bodyLimit does not leak across sibling sub-apps", async () => {
    const parent = new Hono();

    const jsonRouter = new Hono();
    jsonRouter.post("/json", bodyLimit(1024), (c) => c.json({ where: "json" }));

    const multipartRouter = new Hono();
    multipartRouter.post("/multipart", bodyLimit(1024, { multipart: 8 * 1024 }), (c) =>
      c.json({ where: "multipart" }),
    );

    parent.route("/", jsonRouter);
    parent.route("/", multipartRouter);

    const bigMultipart = await parent.request("/multipart", {
      method: "POST",
      headers: {
        "Content-Length": "4096",
        "Content-Type": "multipart/form-data; boundary=abc",
      },
    });
    expect(bigMultipart.status).toBe(200);

    const oversizedJson = await parent.request("/json", {
      method: "POST",
      headers: { "Content-Length": "4096", "Content-Type": "application/json" },
    });
    expect(oversizedJson.status).toBe(413);
    const body = await oversizedJson.json();
    expect(body.details?.limit).toBe(1024);
  });
});
