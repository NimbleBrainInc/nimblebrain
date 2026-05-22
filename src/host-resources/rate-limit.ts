import { McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Server-error code for "rate limited." Lives in the JSON-RPC
 * implementation-defined server-error range (-32000 to -32099), not in
 * the SDK's `ErrorCode` enum (which only covers the spec-reserved
 * codes). `-32603 InternalError` would be semantically wrong here —
 * rate limiting is a deliberate quota response, not a server fault.
 */
const RATE_LIMITED = -32004;

/**
 * Per-(workspace, bundle) rate limit on inbound host-resources requests.
 * Prevents a buggy or runaway bundle from DoSing the FileStore. Resets
 * on platform restart — no persistence needed, the limit is a guard
 * rail not an audit trail.
 *
 * Token bucket semantics: a bundle accrues `ratePerSec` tokens per
 * second up to a `burst` ceiling. Each `check()` debits one token; a
 * call with no tokens throws `-32004 Rate limited` carrying
 * `retryAfterMs` in the error data so a polite bundle can back off
 * intelligently. The code sits in the JSON-RPC impl-defined
 * server-error range (`-32000` to `-32099`) — `-32603 InternalError`
 * would mis-signal a deliberate quota response as a server fault.
 *
 * Phase 2a defaults (not configurable yet — the constructor accepts
 * `RateLimitOptions` but `Runtime.start()` doesn't thread a config
 * block through. Operator-tunable `hostResources.rateLimit` is a
 * tracked follow-up; the current defaults are conservative enough
 * that no operator has needed an override):
 * - ratePerSec: 100   (every 10ms is the steady-state floor)
 * - burst:     1000   (10 seconds of slack for bursty workloads)
 *
 * A bundle that hits these defaults is doing something unusual.
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
  // No eviction by design — bucket count is bounded by the number of
  // distinct `(workspaceId, bundleId)` pairs the runtime has ever
  // seen, which is itself bounded by installed bundles × active
  // workspaces. The map is per-runtime, so a process restart resets
  // it; that's the operational pressure-release valve at scale.
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
      throw new McpError(RATE_LIMITED, "Rate limited", { retryAfterMs });
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
  }
}
