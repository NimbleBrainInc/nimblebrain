import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { RequestRateLimiter } from "../rate-limiter.ts";
import type { AppEnv, AuthEnv } from "../types.ts";
import { apiError } from "../types.ts";

/**
 * Per-user rate limiting middleware for authenticated endpoints.
 * Keys on identity.id from the auth middleware unless the route passes its own
 * `keyOf`. Records every request. The same limits hold under every identity
 * provider; a local setup that needs more raises them with `NB_*_RATE_LIMIT`.
 */
export function requestRateLimit<E extends AuthEnv = AppEnv>(
  limiter: RequestRateLimiter,
  keyOf?: (c: Context<E>) => string,
) {
  return createMiddleware<E>(async (c, next) => {
    const key = keyOf ? keyOf(c) : (c.var.identity?.id ?? "anon");
    const retryAfterSeconds = limiter.consumeWithRetryAfter(key);
    if (retryAfterSeconds !== null) {
      return apiError(429, "rate_limited", "Rate limit exceeded", undefined, {
        "Retry-After": String(retryAfterSeconds),
      });
    }
    await next();
  });
}
