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

  it("returns the time until the next token without extending it on rejection", () => {
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

  it("test_caller_over_rate_is_slowed_to_rate_not_shut_out", () => {
    // 60 a minute: one token a second. A caller asking 10% faster than that,
    // after spending its burst, is admitted at the rate instead of refused
    // until the minute ends.
    const now = spyOn(Date, "now").mockReturnValue(0);
    try {
      const limiter = new RequestRateLimiter(60, 60_000);
      for (let i = 0; i < 60; i++) expect(limiter.consume("u")).toBe(true);
      let admitted = 0;
      const asks = 66;
      for (let i = 1; i <= asks; i++) {
        now.mockReturnValue(Math.round((i * 60_000) / asks));
        if (limiter.consume("u")) admitted += 1;
      }
      expect(admitted).toBeGreaterThanOrEqual(59);
      expect(admitted).toBeLessThanOrEqual(60);
    } finally {
      now.mockRestore();
    }
  });

  it("test_refusal_retry_after_names_next_token_not_window_end", () => {
    const now = spyOn(Date, "now").mockReturnValue(0);
    try {
      const limiter = new RequestRateLimiter(300, 60_000);
      for (let i = 0; i < 300; i++) limiter.consume("u");
      // One token every 200ms: the wait is under a second, said as one.
      expect(limiter.consumeWithRetryAfter("u")).toBe(1);
      now.mockReturnValue(200);
      expect(limiter.consumeWithRetryAfter("u")).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("test_clock_stepped_back_keeps_tokens", () => {
    const now = spyOn(Date, "now").mockReturnValue(10 * 60_000);
    try {
      const limiter = new RequestRateLimiter(3, 60_000);
      expect(limiter.consume("u")).toBe(true);
      // The wall clock steps back ten minutes (an NTP correction).
      now.mockReturnValue(0);
      expect(limiter.consume("u")).toBe(true);
      expect(limiter.consume("u")).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("test_earns_tokens_against_the_clock_it_is_given", () => {
    // 600 a minute is a token every 100ms of the wall clock. On an injected
    // clock that has not moved, a burst earns nothing however long it really
    // takes, and moving that clock is what refills it.
    let clockMs = 0;
    const limiter = new RequestRateLimiter(600, 60_000, () => clockMs);
    for (let i = 0; i < 600; i++) expect(limiter.consume("u")).toBe(true);
    const start = Date.now();
    while (Date.now() - start < 150) {
      // busy-wait past one wall-clock token
    }
    expect(limiter.consume("u")).toBe(false);
    clockMs += 100;
    expect(limiter.consume("u")).toBe(true);
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
