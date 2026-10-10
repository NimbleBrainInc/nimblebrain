import { describe, expect, it, spyOn } from "bun:test";
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

  it("returns the remaining fixed-window time without extending it on rejection", () => {
    const now = spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const limiter = new RequestRateLimiter(1, 60_000);
      expect(limiter.consumeWithRetryAfter("user-1")).toBeNull();

      now.mockReturnValue(31_001);
      expect(limiter.consumeWithRetryAfter("user-1")).toBe(30);
      now.mockReturnValue(60_999);
      expect(limiter.consumeWithRetryAfter("user-1")).toBe(1);
      now.mockReturnValue(61_000);
      expect(limiter.consumeWithRetryAfter("user-1")).toBeNull();
    } finally {
      now.mockRestore();
    }
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
