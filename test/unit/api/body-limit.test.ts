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

  test("passes through malformed Content-Length rather than crashing or 413ing", async () => {
    const app = createTestApp(1024);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": "abc", "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("passes through negative Content-Length rather than 413ing", async () => {
    const app = createTestApp(1024);
    const res = await app.request("/test", {
      method: "POST",
      headers: { "Content-Length": "-1", "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
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

  // Answering while the body is still arriving desynchronizes a keep-alive
  // connection: HTTP/1.1 cannot say "I stopped reading", so the unread bytes
  // are parsed as the next request. The observable contract of the refusal is
  // therefore that the body was consumed, not merely that the status is 413.
  test("consumes an over-limit body before answering", async () => {
    const app = createTestApp(1024);
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Length": "2048", "Content-Type": "application/json" },
      body: "x".repeat(2048),
    });

    const res = await app.fetch(request);

    expect(res.status).toBe(413);
    // False here means the body was abandoned on the wire.
    expect(request.bodyUsed).toBe(true);
  });

  // The ceiling scales with the route's own limit, so a multipart route whose
  // limit sits above any flat constant still gets its refusals drained. Before
  // this, `chat.ts` and `resources.ts` passed a 100 MB multipart limit into a
  // fixed 8 MB ceiling and no multipart refusal was ever drained on a default
  // deployment — the connection-desync fix reached only the JSON routes.
  test("drains a multipart refusal whose limit is above any flat ceiling", async () => {
    const app = createTestApp(1024, { multipart: 16 * 1024 * 1024 });
    const oversized = "x".repeat(20 * 1024 * 1024);
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: {
        "Content-Length": String(oversized.length),
        "Content-Type": "multipart/form-data; boundary=abc",
      },
      body: oversized,
    });

    const res = await app.fetch(request);

    expect(res.status).toBe(413);
    // 20 MB is over the 16 MB limit but inside the 8 MB overrun allowance.
    expect(request.bodyUsed).toBe(true);
  });

  // The other half of that trade: the read is work an unauthenticated caller
  // can ask for, so past the overrun allowance the refusal goes out immediately
  // and the connection takes the consequences. Bounding the OVERRUN rather than
  // the total is what makes that safe — a caller in budget can already cost the
  // route `limit` bytes, so only the excess is new work.
  test("refuses a multipart body past the overrun allowance without reading it", async () => {
    const app = createTestApp(1024, { multipart: 16 * 1024 * 1024 });
    const oversized = "x".repeat(25 * 1024 * 1024);
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: {
        "Content-Length": String(oversized.length),
        "Content-Type": "multipart/form-data; boundary=abc",
      },
      body: oversized,
    });

    const res = await app.fetch(request);

    expect(res.status).toBe(413);
    // 25 MB is more than 8 MB past the 16 MB limit.
    expect(request.bodyUsed).toBe(false);
  });

  test("refuses a body past the drain ceiling without reading it", async () => {
    const app = createTestApp(1024);
    const oversized = "x".repeat(9 * 1024 * 1024);
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: {
        "Content-Length": String(oversized.length),
        "Content-Type": "application/json",
      },
      body: oversized,
    });

    const res = await app.fetch(request);

    expect(res.status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  // A sender can stop mid-body. Without a deadline the refusal waits on it,
  // and the caller gets nothing until the server's idle timeout closes the
  // socket — so the drain has to give up and answer.
  test("answers a refusal whose body stalls mid-transfer", async () => {
    const app = createTestApp(1024);
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Length": "2000000", "Content-Type": "application/json" },
      // One chunk, then the sender goes quiet and never closes the stream.
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(16));
        },
      }),
      duplex: "half",
    } as RequestInit);

    const started = performance.now();
    const res = await app.fetch(request);
    const elapsed = performance.now() - started;

    expect(res.status).toBe(413);
    // Bounded by the drain deadline, not by the server's idle timeout.
    expect(elapsed).toBeLessThan(4_000);
  });

  // The deadline asks whether the sender has stopped, not how long the drain
  // has run. A total budget would answer both with one number and cut off the
  // drains that need it most: a multipart limit runs to 100 MB, which no budget
  // worth granting a *stalled* sender is long enough to cover. This body takes
  // 2.7s to arrive — past any such budget — while never pausing longer than the
  // stall window, so it must be drained in full.
  test("drains a slow body that never stalls", async () => {
    const app = createTestApp(1024);
    const chunks = 3;
    const gapMs = 900;
    let delivered = 0;
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "Content-Length": "2000000", "Content-Type": "application/json" },
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          await Bun.sleep(gapMs);
          if (delivered === chunks) {
            controller.close();
            return;
          }
          delivered++;
          controller.enqueue(new Uint8Array(16));
        },
      }),
      duplex: "half",
    } as RequestInit);

    const res = await app.fetch(request);

    expect(res.status).toBe(413);
    // Every chunk read: the drain outlived a 2s total budget without stalling.
    expect(delivered).toBe(chunks);
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
