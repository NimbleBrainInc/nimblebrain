import { Hono } from "hono";
import {
  handleLogout,
  handleOidcAuthorize,
  handleOidcCallback,
  handleOidcRefresh,
} from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { type AppContext, type AuthEnv, apiError } from "../types.ts";

export function authRoutes(ctx: AppContext) {
  const app = new Hono();

  // --- Unauthenticated ---
  app.get("/v1/auth/authorize", (_c) => {
    if (!ctx.provider) return apiError(400, "not_configured", "Auth provider not configured");
    return handleOidcAuthorize(ctx.provider);
  });

  app.get("/v1/auth/callback", (c) => {
    if (!ctx.provider) return apiError(400, "not_configured", "Auth provider not configured");
    return handleOidcCallback(c.req.raw, ctx.provider, ctx.isLocalhost, ctx.appOrigin);
  });

  app.post("/v1/auth/refresh", (c) => {
    if (!ctx.provider) return apiError(400, "not_configured", "Auth provider not configured");
    return handleOidcRefresh(c.req.raw, ctx.provider, ctx.isLocalhost);
  });

  // --- Authenticated ---
  const authed = new Hono<AuthEnv>();
  authed.use("*", requireAuth(ctx.authOptions));
  authed.post("/v1/auth/logout", (_c) => handleLogout());

  app.route("/", authed);

  return app;
}
