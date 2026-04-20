import { Hono } from "hono";
import { handleFileServe, handleShell, handleToolCall } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requestRateLimit } from "../middleware/rate-limit.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

export function toolRoutes(ctx: AppContext) {
  return new Hono<AppEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .use("*", requireWorkspace(ctx.workspaceStore))
    .use("*", errorLog(ctx))
    .post("/v1/tools/call", requestRateLimit(ctx.toolCallLimiter), (c) =>
      handleToolCall(c.req.raw, ctx.runtime, ctx.features, {
        sseManager: ctx.sseManager,
        eventSink: ctx.eventSink,
        identity: c.var.identity,
        workspaceId: c.var.workspaceId,
      }),
    )
    .get("/v1/shell", (c) => handleShell(ctx.runtime, c.var.workspaceId))
    .get("/v1/files/:fileId", (c) => {
      const fileId = decodeURIComponent(c.req.param("fileId"));
      return handleFileServe(fileId, ctx.runtime, ctx.features, c.var.workspaceId);
    });
}
