import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { requestRateLimit } from "../../../src/api/middleware/rate-limit.ts";
import { RequestRateLimiter } from "../../../src/api/rate-limiter.ts";
import type { ApiErrorBody } from "../../../src/api/schemas/responses.ts";
import type { AppEnv } from "../../../src/api/types.ts";
import { readJson } from "../../helpers/http.ts";
import { makeIdentity } from "../../helpers/identity.ts";

/** A workspace chat route, the kind of route requestRateLimit guards. */
const CHAT_PATH = "/v1/workspaces/ws_00079598e311c160/chat";

/**
 * Build a Hono app that simulates authenticated routes with requestRateLimit.
 * Sets identity in middleware to simulate requireAuth having run first.
 */
function buildAuthenticatedApp(limiter: RequestRateLimiter, userId = "user-1") {
  const app = new Hono<AppEnv>();
  // Simulate requireAuth setting identity
  app.use("*", async (c, next) => {
    c.set(
      "identity",
      makeIdentity({
        id: userId,
        email: "test@test.com",
      }),
    );
    await next();
  });
  app.use("*", requestRateLimit(limiter));
  app.post(CHAT_PATH, (c) => c.json({ ok: true }));
  return app;
}

describe("requestRateLimit middleware", () => {
  it("allows requests under the limit", async () => {
    const limiter = new RequestRateLimiter(3, 60_000);
    const app = buildAuthenticatedApp(limiter);

    for (let i = 0; i < 3; i++) {
      const res = await app.request(CHAT_PATH, { method: "POST" });
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 when limit is exceeded", async () => {
    const limiter = new RequestRateLimiter(2, 60_000);
    const app = buildAuthenticatedApp(limiter);

    await app.request(CHAT_PATH, { method: "POST" });
    await app.request(CHAT_PATH, { method: "POST" });

    const res = await app.request(CHAT_PATH, { method: "POST" });
    expect(res.status).toBe(429);

    const body = await readJson<ApiErrorBody>(res);
    expect(body.error).toBe("rate_limited");
    expect(body.message).toBe("Rate limit exceeded");
    expect(res.headers.get("Retry-After")).toBe("60");
  });

  it("tracks different users independently", async () => {
    const limiter = new RequestRateLimiter(2, 60_000);

    const app = new Hono<AppEnv>();
    // Dynamic user based on header
    app.use("*", async (c, next) => {
      const userId = c.req.header("X-Test-User") ?? "default";
      c.set(
        "identity",
        makeIdentity({
          id: userId,
          email: "t@t.com",
        }),
      );
      await next();
    });
    app.use("*", requestRateLimit(limiter));
    app.post(CHAT_PATH, (c) => c.json({ ok: true }));

    // User A exhausts their limit
    for (let i = 0; i < 2; i++) {
      const res = await app.request(CHAT_PATH, {
        method: "POST",
        headers: { "X-Test-User": "user-a" },
      });
      expect(res.status).toBe(200);
    }
    const resA = await app.request(CHAT_PATH, {
      method: "POST",
      headers: { "X-Test-User": "user-a" },
    });
    expect(resA.status).toBe(429);

    // User B still has their full budget
    const resB = await app.request(CHAT_PATH, {
      method: "POST",
      headers: { "X-Test-User": "user-b" },
    });
    expect(resB.status).toBe(200);
  });

  it("uses 'anon' key when no identity is set", async () => {
    const limiter = new RequestRateLimiter(1, 60_000);
    const app = new Hono();
    // No identity middleware — simulates unauthenticated fallback
    app.use("*", requestRateLimit(limiter));
    app.post(CHAT_PATH, (c) => c.json({ ok: true }));

    const res1 = await app.request(CHAT_PATH, { method: "POST" });
    expect(res1.status).toBe(200);

    const res2 = await app.request(CHAT_PATH, { method: "POST" });
    expect(res2.status).toBe(429);
  });
});
