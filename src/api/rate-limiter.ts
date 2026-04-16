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

/**
 * Per-IP rate limiter for login attempts.
 * In-memory sliding window — no external dependencies.
 */
export class LoginRateLimiter {
  private attempts = new Map<string, { count: number; windowStart: number }>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private globalAttempts = 0;
  private globalWindowStart = Date.now();

  constructor(
    private readonly maxAttempts: number = 10,
    private readonly windowMs: number = 60_000,
    private readonly maxGlobalAttempts: number = 50,
  ) {}

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

  /** Returns true if the IP is under the rate limit (request allowed). */
  check(ip: string): boolean {
    const entry = this.attempts.get(ip);
    if (!entry) return true;

    // Window expired — treat as fresh
    if (Date.now() - entry.windowStart >= this.windowMs) {
      this.attempts.delete(ip);
      return true;
    }

    return entry.count < this.maxAttempts;
  }

  /** Record a failed login attempt for the given IP. */
  record(ip: string): void {
    const now = Date.now();
    const entry = this.attempts.get(ip);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.attempts.set(ip, { count: 1, windowStart: now });
    } else {
      entry.count++;
    }
  }

  /** Clear attempt tracking for the given IP (call on successful auth). */
  clear(ip: string): void {
    this.attempts.delete(ip);
  }

  /** Returns true if total attempts across all keys are under the global limit. */
  checkGlobal(): boolean {
    if (Date.now() - this.globalWindowStart >= this.windowMs) {
      this.globalAttempts = 0;
      this.globalWindowStart = Date.now();
    }
    return this.globalAttempts < this.maxGlobalAttempts;
  }

  /** Record a failed login attempt against the global counter. */
  recordGlobal(): void {
    if (Date.now() - this.globalWindowStart >= this.windowMs) {
      this.globalAttempts = 0;
      this.globalWindowStart = Date.now();
    }
    this.globalAttempts++;
  }

  /** Remove all entries whose window has expired. */
  cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.attempts) {
      if (now - entry.windowStart >= this.windowMs) {
        this.attempts.delete(ip);
      }
    }
  }
}
