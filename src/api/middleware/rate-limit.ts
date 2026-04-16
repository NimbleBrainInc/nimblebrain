import { createMiddleware } from "hono/factory";
import type { LoginRateLimiter, RequestRateLimiter } from "../rate-limiter.ts";
import type { AppEnv } from "../types.ts";
import { apiError } from "../types.ts";

/**
 * Per-user rate limiting middleware for authenticated endpoints.
 * Keys on identity.id from the auth middleware. Records every request.
 */
export function requestRateLimit(limiter: RequestRateLimiter) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const key = c.var.identity?.id ?? "anon";
    if (!limiter.consume(key)) {
      return apiError(429, "rate_limited", "Rate limit exceeded", undefined, {
        "Retry-After": String(limiter.windowSeconds),
      });
    }
    await next();
  });
}

/**
 * Per-IP rate limiting middleware for login endpoint.
 * Checks before handler, records failures / clears on success after handler.
 */
export function rateLimit(rateLimiter: LoginRateLimiter) {
  return createMiddleware(async (c, next) => {
    // Use "direct" as the rate limit key for all requests.
    // Never trust X-Forwarded-For or X-Real-IP — attackers can spoof these
    // headers to create separate buckets and bypass rate limiting entirely.
    // In production behind a reverse proxy, the proxy handles IP tracking.
    const ip = "direct";

    if (!rateLimiter.check(ip) || !rateLimiter.checkGlobal()) {
      return apiError(429, "rate_limited", "Too many login attempts", undefined, {
        "Retry-After": "60",
      });
    }

    await next();

    // Record failed attempts, clear on success
    const status = c.res.status;
    if (status === 401 || status === 403) {
      rateLimiter.record(ip);
      rateLimiter.recordGlobal();
    } else if (status === 200) {
      rateLimiter.clear(ip);
    }
  });
}
