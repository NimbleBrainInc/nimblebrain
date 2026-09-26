import { Hono } from "hono";
import { handleFileServe, handleShell, handleToolCall } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requestRateLimit } from "../middleware/rate-limit.ts";
import { requireWorkspace, WORKSPACE_ROUTE_PREFIX } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

export function toolRoutes(ctx: AppContext) {
  // A tool call is workspace-scoped whatever its source: a workspace source
  // dispatches into that workspace's registry, and an identity source
  // (conversations, files, automations) reads and writes that workspace's
  // partition. `/v1/files/:fileId` is identity-scoped: the file id locates its
  // workspace, within the caller's own files.
  return new Hono<AppEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .use("*", errorLog(ctx))
    .post(
      `${WORKSPACE_ROUTE_PREFIX}/tools/call`,
      requireWorkspace(ctx),
      bodyLimit(1_048_576),
      requestRateLimit(ctx.toolCallLimiter, { bypass: ctx.isDevMode }),
      (c) =>
        handleToolCall(c.req.raw, ctx.runtime, ctx.features, {
          sseManager: ctx.sseManager,
          eventSink: ctx.eventSink,
          identity: c.var.identity,
          workspaceId: c.var.workspaceId,
        }),
    )
    .get(`${WORKSPACE_ROUTE_PREFIX}/shell`, requireWorkspace(ctx), (c) =>
      handleShell(ctx.runtime, c.var.workspaceId),
    )
    .get("/v1/files/:fileId", (c) => {
      // Files are workspace-owned but addressed by their globally-unique id alone:
      // the server resolves the workspace from the id within the caller's own
      // owner partitions (see handleFileServe). No workspace in the URL, so a
      // browser `<img src>` or download link can load it.
      const fileId = decodeURIComponent(c.req.param("fileId"));
      return handleFileServe(fileId, ctx.runtime, ctx.features, c.var.identity);
    });
}
