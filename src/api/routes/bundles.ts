import { Hono } from "hono";
import { handleBundleUpload } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

const MAX_BUNDLE_SIZE = 200 * 1024 * 1024; // 200 MB

export function bundleRoutes(ctx: AppContext) {
  return new Hono<AppEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .use("*", requireWorkspace(ctx.workspaceStore))
    .use("*", errorLog(ctx))
    .post(
      "/v1/bundles/upload",
      bodyLimit(1_048_576, { multipart: MAX_BUNDLE_SIZE }),
      (c) => handleBundleUpload(c.req.raw, ctx.runtime, c.var.workspaceId),
    );
}
