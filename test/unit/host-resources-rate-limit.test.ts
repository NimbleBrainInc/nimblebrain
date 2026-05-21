import { describe, expect, it } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_BURST,
  DEFAULT_RATE_PER_SEC,
  TokenBucketRateLimit,
} from "../../src/host-resources/index.ts";

// The rate limiter is per-(workspaceId, bundleId). One greedy bundle
// can't starve another, and one workspace can't starve another. Each
// `check()` call debits one token; exhaustion throws JSON-RPC -32603
// with retryAfterMs in the error data so a polite bundle can back off.

describe("TokenBucketRateLimit defaults", () => {
  it("exposes the documented defaults", () => {
    expect(DEFAULT_RATE_PER_SEC).toBe(100);
    expect(DEFAULT_BURST).toBe(1000);
  });
});

describe("TokenBucketRateLimit.check", () => {
  it("admits a single call without throwing", () => {
    const rl = new TokenBucketRateLimit();
    expect(() => rl.check("ws_a", "bundle_x")).not.toThrow();
  });

  it("admits up to `burst` calls back-to-back", () => {
    let now = 1000;
    const rl = new TokenBucketRateLimit({ burst: 5, ratePerSec: 1, now: () => now });
    for (let i = 0; i < 5; i++) {
      expect(() => rl.check("ws_a", "bundle_x")).not.toThrow();
    }
  });

  it("rejects the (burst+1)th call within the same instant", () => {
    let now = 1000;
    const rl = new TokenBucketRateLimit({ burst: 3, ratePerSec: 1, now: () => now });
    rl.check("ws_a", "bundle_x");
    rl.check("ws_a", "bundle_x");
    rl.check("ws_a", "bundle_x");
    expect(() => rl.check("ws_a", "bundle_x")).toThrow();
  });

  it("rejected calls throw McpError with retryAfterMs", () => {
    let now = 1000;
    const rl = new TokenBucketRateLimit({ burst: 1, ratePerSec: 10, now: () => now });
    rl.check("ws_a", "bundle_x");
    let caught: McpError | null = null;
    try {
      rl.check("ws_a", "bundle_x");
    } catch (e) {
      caught = e as McpError;
    }
    expect(caught).toBeInstanceOf(McpError);
    const data = caught?.data as { retryAfterMs?: number } | undefined;
    expect(typeof data?.retryAfterMs).toBe("number");
    expect(data?.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time at ratePerSec", () => {
    let now = 1000;
    const rl = new TokenBucketRateLimit({ burst: 1, ratePerSec: 10, now: () => now });
    rl.check("ws_a", "bundle_x");
    expect(() => rl.check("ws_a", "bundle_x")).toThrow();
    // 100ms later, one new token has accrued (10/sec * 0.1sec = 1).
    now = 1100;
    expect(() => rl.check("ws_a", "bundle_x")).not.toThrow();
  });

  it("isolates buckets per (workspaceId, bundleId)", () => {
    let now = 1000;
    const rl = new TokenBucketRateLimit({ burst: 1, ratePerSec: 1, now: () => now });
    rl.check("ws_a", "bundle_x");
    // Different workspace — independent bucket, admits immediately.
    expect(() => rl.check("ws_b", "bundle_x")).not.toThrow();
    // Different bundle in same workspace — also independent.
    expect(() => rl.check("ws_a", "bundle_y")).not.toThrow();
    // Same workspace+bundle — exhausted.
    expect(() => rl.check("ws_a", "bundle_x")).toThrow();
  });

  it("does not refill past the burst ceiling", () => {
    let now = 1000;
    const rl = new TokenBucketRateLimit({ burst: 3, ratePerSec: 1, now: () => now });
    // Idle for 1000 seconds — bucket would mathematically refill to 1003,
    // but ceiling caps at 3. So only 3 calls succeed in a row.
    now = 1001 * 1000;
    rl.check("ws_a", "bundle_x");
    rl.check("ws_a", "bundle_x");
    rl.check("ws_a", "bundle_x");
    expect(() => rl.check("ws_a", "bundle_x")).toThrow();
  });
});
