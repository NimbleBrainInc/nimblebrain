/**
 * General-purpose per-key token-bucket rate limiter.
 * Records every request unconditionally — no login-specific semantics.
 *
 * Each key holds up to `maxRequests` tokens and earns them back at
 * `maxRequests` per `windowMs`, so the sustained rate and the burst are what
 * the two numbers say. A request spends one token; with none left it is
 * refused until the next token is earned. A caller slightly over the rate is
 * slowed to the rate rather than shut out: a fixed window admits the whole
 * budget at once and then refuses everything until the window resets, which
 * turns a small overrun into up to `windowMs` of total refusal.
 */
export class RequestRateLimiter {
  private buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * `now` is the clock the bucket earns tokens against. It defaults to the wall
   * clock; a test passes its own so a burst's real duration earns nothing.
   */
  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Start periodic cleanup of full buckets. */
  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanup(), this.windowMs);
  }

  /** Stop the cleanup interval. */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Check whether the key is under the limit and record the request atomically.
   * Returns true if the request is allowed, false if rate-limited.
   */
  consume(key: string): boolean {
    return this.consumeWithRetryAfter(key) === null;
  }

  /** Consume a request, or return the whole seconds until the key earns its next token. */
  consumeWithRetryAfter(key: string): number | null {
    const now = this.now();
    const tokens = this.tokensAt(key, now);
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
      return null;
    }
    // A refusal spends nothing, so retrying early does not push the wait back.
    this.buckets.set(key, { tokens, updatedAt: now });
    return Math.max(1, Math.ceil(((1 - tokens) * this.windowMs) / this.maxRequests / 1000));
  }

  /** Remove every key whose bucket has refilled: it holds nothing a fresh one would not. */
  cleanup(): void {
    const now = this.now();
    for (const key of this.buckets.keys()) {
      if (this.tokensAt(key, now) >= this.maxRequests) this.buckets.delete(key);
    }
  }

  /**
   * The key's tokens at `now`: what it held, plus what it has earned since, up
   * to the cap. A clock stepped backwards earns nothing rather than taking
   * tokens away, and the next request re-bases the bucket on the new time.
   */
  private tokensAt(key: string, now: number): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.maxRequests;
    const earned = (Math.max(0, now - bucket.updatedAt) * this.maxRequests) / this.windowMs;
    return Math.min(this.maxRequests, bucket.tokens + earned);
  }
}
