/**
 * General-purpose per-key sliding-window rate limiter.
 * Records every request unconditionally — no login-specific semantics.
 */
export class RequestRateLimiter {
  private requests = new Map<string, { count: number; windowStart: number }>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  /** Window duration in seconds (for Retry-After headers). */
  get windowSeconds(): number {
    return Math.ceil(this.windowMs / 1000);
  }

  /** Start periodic cleanup of expired windows. */
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
    const now = Date.now();
    const entry = this.requests.get(key);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.requests.set(key, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= this.maxRequests) {
      return false;
    }

    entry.count++;
    return true;
  }

  /** Remove all entries whose window has expired. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.requests) {
      if (now - entry.windowStart >= this.windowMs) {
        this.requests.delete(key);
      }
    }
  }
}
