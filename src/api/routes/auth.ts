import { Hono } from "hono";
import {
  handleLogout,
  handleOidcAuthorize,
  handleOidcCallback,
  handleOidcRefresh,
} from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { type AppContext, apiError } from "../types.ts";

export function authRoutes(ctx: AppContext) {
  const app = new Hono();
  const limit = bodyLimit(1_048_576);

  // --- Unauthenticated ---
  app.get("/v1/auth/authorize", (_c) => {
    if (!ctx.provider) return apiError(400, "not_configured", "Auth provider not configured");
    return handleOidcAuthorize(ctx.provider);
  });

  app.get("/v1/auth/callback", (c) => {
    if (!ctx.provider) return apiError(400, "not_configured", "Auth provider not configured");
    return handleOidcCallback(c.req.raw, ctx.provider, ctx.secureCookies, ctx.appOrigin);
  });

  app.post("/v1/auth/refresh", limit, (c) => {
    if (!ctx.provider) return apiError(400, "not_configured", "Auth provider not configured");
    return handleOidcRefresh(c.req.raw, ctx.provider, ctx.secureCookies);
  });

  // --- Authenticated ---
  // requireAuth is attached PER-ROUTE, never through a nested sub-app
  // `.use("*")`. Hono flattens a sub-app's `.use("*")` into a `/*` matcher
  // that runs for every request reaching the parent AFTER this sub-app is
  // mounted — so a wildcard here would leak onto the sub-apps mounted after
  // authRoutes in app.ts (mcp-auth, composio-auth) and silently 401 their
  // unauthenticated-by-design OAuth callbacks. Same footgun called out in
  // mcp-auth.ts and conversation-events.ts.
  app.post("/v1/auth/logout", requireAuth(ctx.authOptions), limit, (_c) => handleLogout());

  return app;
}
