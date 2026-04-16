import { Hono } from "hono";
import { handleBootstrap } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { AppContext, AuthEnv } from "../types.ts";

export function bootstrapRoutes(ctx: AppContext) {
  return new Hono<AuthEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .get("/v1/bootstrap", (c) => handleBootstrap(c.req.raw, ctx.runtime, c.var.identity));
}
