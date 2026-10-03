import { Hono } from "hono";
import {
  handleFileServe,
  handleIdentityToolCall,
  handleShell,
  handleToolCall,
} from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requestRateLimit } from "../middleware/rate-limit.ts";
import { requireWorkspace, WORKSPACE_ROUTE_PREFIX } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

export function toolRoutes(ctx: AppContext) {
  // A tool call under `/v1/workspaces/:wsId/` is workspace-scoped whatever its
  // source: a workspace source dispatches into that workspace's registry, and
  // an identity source (conversations, files, automations) reads and writes
  // that workspace's partition. `/v1/tools/call` names no workspace (see its
  // route below). `/v1/files/:fileId` is identity-scoped: the file id locates
  // its workspace, within the caller's own files.
  const auth = requireAuth(ctx.authOptions);
  const logErrors = errorLog(ctx);
  return (
    new Hono<AppEnv>()
      .post(
        `${WORKSPACE_ROUTE_PREFIX}/tools/call`,
        auth,
        logErrors,
        requireWorkspace(ctx),
        bodyLimit(1_048_576),
        requestRateLimit(ctx.toolCallLimiter),
        (c) =>
          handleToolCall(c.req.raw, ctx.runtime, ctx.features, {
            eventSink: ctx.eventSink,
            identity: c.var.identity,
            workspaceId: c.var.workspaceId,
          }),
      )
      // A kernel tool that acts on the caller or the org, called with no
      // workspace: the org and profile settings. Only tools that declare they
      // work without one (`tools/workspace-optional.ts`). ADR-0043.
      .post(
        "/v1/tools/call",
        auth,
        logErrors,
        bodyLimit(1_048_576),
        requestRateLimit(ctx.toolCallLimiter),
        (c) =>
          handleIdentityToolCall(c.req.raw, ctx.runtime, ctx.features, {
            eventSink: ctx.eventSink,
            identity: c.var.identity,
          }),
      )
      .get(`${WORKSPACE_ROUTE_PREFIX}/shell`, auth, logErrors, requireWorkspace(ctx), (c) =>
        handleShell(ctx.runtime, c.var.workspaceId),
      )
      .get("/v1/files/:fileId", auth, logErrors, (c) => {
        // Files are workspace-owned but addressed by their globally-unique id alone:
        // the server resolves the workspace from the id within the caller's own
        // owner partitions (see handleFileServe). No workspace in the URL, so a
        // browser `<img src>` or download link can load it.
        const fileId = decodeURIComponent(c.req.param("fileId"));
        return handleFileServe(fileId, ctx.runtime, ctx.features, c.var.identity);
      })
  );
}
