import { describe, expect, it } from "bun:test";
import { RequestRateLimiter } from "../../src/api/rate-limiter.ts";

describe("RequestRateLimiter", () => {
  it("allows requests up to the limit", () => {
    const limiter = new RequestRateLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.consume("user-1")).toBe(true);
    }
  });

  it("rejects requests over the limit", () => {
    const limiter = new RequestRateLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) {
      expect(limiter.consume("user-1")).toBe(true);
    }
    expect(limiter.consume("user-1")).toBe(false);
  });

  it("tracks different keys independently", () => {
    const limiter = new RequestRateLimiter(2, 60_000);
    expect(limiter.consume("user-1")).toBe(true);
    expect(limiter.consume("user-1")).toBe(true);
    expect(limiter.consume("user-1")).toBe(false);
    // Different user still has their full budget
    expect(limiter.consume("user-2")).toBe(true);
    expect(limiter.consume("user-2")).toBe(true);
    expect(limiter.consume("user-2")).toBe(false);
  });

  it("resets after window expires", () => {
    // 50ms window — the consume() pair below must land inside the same
    // window. A 1ms window was racy under load (loop spanned >1ms,
    // silently resetting the count between calls).
    const windowMs = 50;
    const limiter = new RequestRateLimiter(2, windowMs);
    expect(limiter.consume("user-1")).toBe(true);
    expect(limiter.consume("user-1")).toBe(true);
    expect(limiter.consume("user-1")).toBe(false);

    const start = Date.now();
    while (Date.now() - start < windowMs * 2) {
      // busy-wait
    }

    expect(limiter.consume("user-1")).toBe(true);
  });

  it("exposes windowSeconds", () => {
    expect(new RequestRateLimiter(10, 60_000).windowSeconds).toBe(60);
    expect(new RequestRateLimiter(10, 30_000).windowSeconds).toBe(30);
  });

  it("removes expired entries on cleanup", () => {
    const limiter = new RequestRateLimiter(2, 1);
    limiter.consume("user-1");
    limiter.consume("user-1");
    expect(limiter.consume("user-1")).toBe(false);

    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait
    }

    limiter.cleanup();
    // After cleanup + expired window, user gets fresh budget
    expect(limiter.consume("user-1")).toBe(true);
  });
});
