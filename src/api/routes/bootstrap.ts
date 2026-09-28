import { Hono } from "hono";
import { handleBootstrap } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import type { AppContext, AuthEnv } from "../types.ts";

export function bootstrapRoutes(ctx: AppContext) {
  return new Hono<AuthEnv>().get("/v1/bootstrap", requireAuth(ctx.authOptions), (c) =>
    handleBootstrap(ctx.runtime, c.var.identity),
  );
}
