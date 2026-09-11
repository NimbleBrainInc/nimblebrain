import { Hono } from "hono";
import {
  handleLogout,
  handleOidcAuthorize,
  handleOidcCallback,
  handleOidcRefresh,
} from "../handlers.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { type AppContext, apiError } from "../types.ts";

export function authRoutes(ctx: AppContext) {
  const app = new Hono();
  const limit = bodyLimit(1_048_576);

  // Every route here is unauthenticated. Never give this sub-app a
  // `.use("*")`: Hono flattens a sub-app's `.use("*")` into a `/*` matcher
  // that runs for every request reaching the parent AFTER this sub-app is
  // mounted, so a wildcard here would leak onto the sub-apps mounted after
  // authRoutes in app.ts (mcp-auth, composio-auth) and 401 their
  // unauthenticated-by-design OAuth callbacks. Same footgun called out in
  // mcp-auth.ts and conversation-events.ts.
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

  // Logout needs no identity: clearing the session cookies is the whole act.
  // The case it must handle is a lapsed access token, where `nb_refresh` is the
  // only live credential left in the browser. Requiring JSON forces a CORS
  // preflight, which a foreign origin fails, so a cross-site form cannot sign
  // the user out.
  app.post("/v1/auth/logout", limit, (c) => {
    const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      return apiError(
        415,
        "unsupported_media_type",
        "Logout requires Content-Type: application/json",
      );
    }
    return handleLogout();
  });

  return app;
}
