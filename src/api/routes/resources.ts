import { Hono } from "hono";
import { handleResourceProxy } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

export function resourceRoutes(ctx: AppContext) {
  return new Hono<AppEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .use("*", requireWorkspace(ctx.workspaceStore))
    .use("*", errorLog(ctx))
    .get("/v1/apps/:name/resources/*", (c) => {
      const name = decodeURIComponent(c.req.param("name"));
      // Extract the full resource path after /resources/
      const url = new URL(c.req.url);
      const prefix = `/v1/apps/${c.req.param("name")}/resources/`;
      const resourcePath = decodeURIComponent(url.pathname.slice(prefix.length));
      return handleResourceProxy(name, resourcePath, ctx.runtime, c.var.workspaceId);
    });
}
