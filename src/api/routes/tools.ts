import { Hono } from "hono";
import { handleFileServe, handleShell, handleToolCall } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requestRateLimit } from "../middleware/rate-limit.ts";
import { optionalWorkspace, requireWorkspace } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

export function toolRoutes(ctx: AppContext) {
  // Workspace resolution is per-route. `/v1/tools/call` uses optionalWorkspace:
  // a tool call may target an identity source (conversations, …) that has NO
  // workspace, so a header isn't required — `handleToolCall` routes identity
  // sources through the identity door and still 400s a workspace source called
  // without a workspace. `/v1/shell` and `/v1/files` stay workspace-scoped.
  return new Hono<AppEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .use("*", errorLog(ctx))
    .post(
      "/v1/tools/call",
      optionalWorkspace(ctx.workspaceStore),
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
    .get("/v1/shell", requireWorkspace(ctx.workspaceStore), (c) =>
      handleShell(ctx.runtime, c.var.workspaceId),
    )
    .get("/v1/files/:fileId", (c) => {
      // Files are identity-owned (Phase B) — no workspace needed; the store is
      // resolved from the authenticated identity.
      const fileId = decodeURIComponent(c.req.param("fileId"));
      return handleFileServe(fileId, ctx.runtime, ctx.features, c.var.identity);
    });
}
