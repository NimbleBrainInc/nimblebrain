import { createMiddleware } from "hono/factory";
import type { RequestRateLimiter } from "../rate-limiter.ts";
import type { AppEnv } from "../types.ts";
import { apiError } from "../types.ts";

/**
 * Per-user rate limiting middleware for authenticated endpoints.
 * Keys on identity.id from the auth middleware. Records every request. The
 * same limits hold under every identity provider; a local setup that needs
 * more raises them with `NB_*_RATE_LIMIT`.
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
