import { createMiddleware } from "hono/factory";
import type { LoginRateLimiter, RequestRateLimiter } from "../rate-limiter.ts";
import type { AppEnv } from "../types.ts";
import { apiError } from "../types.ts";

/**
 * Per-user rate limiting middleware for authenticated endpoints.
 * Keys on identity.id from the auth middleware. Records every request.
 *
 * `bypass` short-circuits the limiter entirely — used in dev mode (no real
 * identity provider configured), where rate limiting is a multi-tenant abuse
 * control with no purpose: there's a single local user, and every request
 * collapses to one shared identity (`usr_default`), so a per-identity budget
 * is meaningless and only creates friction.
 */
export function requestRateLimit(limiter: RequestRateLimiter, opts?: { bypass?: boolean }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (opts?.bypass) {
      await next();
      return;
    }
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
