import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Per-(workspace, bundle) rate limit on inbound host-resources requests.
 * Prevents a buggy or runaway bundle from DoSing the FileStore. Resets
 * on platform restart — no persistence needed, the limit is a guard
 * rail not an audit trail.
 *
 * Token bucket semantics: a bundle accrues `ratePerSec` tokens per
 * second up to a `burst` ceiling. Each `check()` debits one token; a
 * call with no tokens throws `-32603 Rate limited` carrying
 * `retryAfterMs` in the error data so a polite bundle can back off
 * intelligently.
 *
 * Phase 2a tunables (host-resources/capability defaults):
 * - ratePerSec: 100   (every 10ms is the steady-state floor)
 * - burst:     1000   (10 seconds of slack for bursty workloads)
 *
 * These are runtime config overrides via `nimblebrain.json`'s
 * `hostResources.rateLimit` block. Defaults are conservative; a bundle
 * that hits them is doing something unusual.
 */
export interface HostResourcesRateLimit {
  /**
   * Debits one token from the (workspace, bundle) bucket. Throws when
   * the bucket is empty.
   */
  check(workspaceId: string, bundleId: string): void;
}

export interface RateLimitOptions {
  ratePerSec?: number;
  burst?: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export const DEFAULT_RATE_PER_SEC = 100;
export const DEFAULT_BURST = 1000;

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketRateLimit implements HostResourcesRateLimit {
  private readonly buckets = new Map<string, Bucket>();
  private readonly ratePerSec: number;
  private readonly burst: number;
  private readonly now: () => number;

  constructor(opts: RateLimitOptions = {}) {
    this.ratePerSec = opts.ratePerSec ?? DEFAULT_RATE_PER_SEC;
    this.burst = opts.burst ?? DEFAULT_BURST;
    this.now = opts.now ?? Date.now;
  }

  check(workspaceId: string, bundleId: string): void {
    const key = `${workspaceId}|${bundleId}`;
    const now = this.now();
    const existing = this.buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: this.burst, lastRefillMs: now };

    if (existing) {
      const elapsedSec = (now - bucket.lastRefillMs) / 1000;
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsedSec * this.ratePerSec);
      bucket.lastRefillMs = now;
    }

    if (bucket.tokens < 1) {
      // Round up so callers retrying at the suggested time can succeed.
      const deficit = 1 - bucket.tokens;
      const retryAfterMs = Math.ceil((deficit / this.ratePerSec) * 1000);
      this.buckets.set(key, bucket);
      throw new McpError(ErrorCode.InternalError, "Rate limited", { retryAfterMs });
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
  }
}
