import { createMiddleware } from "hono/factory";
import {
  type AuthMiddlewareOptions,
  authenticateRequest,
  isAuthError,
} from "../auth-middleware.ts";
import type { AuthEnv } from "../types.ts";

/**
 * Authentication middleware. Calls authenticateRequest() and sets
 * c.var.identity on success via the return value.
 */
export function requireAuth(options: AuthMiddlewareOptions) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const result = await authenticateRequest(c.req.raw, options);
    if (isAuthError(result)) return result;

    if (result.identity) {
      c.set("identity", result.identity);
    }
    await next();
  });
}
