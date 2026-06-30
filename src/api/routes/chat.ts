import { Hono } from "hono";
import { handleChat, handleChatCancel, handleChatStart, handleChatStream } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requestRateLimit } from "../middleware/rate-limit.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

export function chatRoutes(ctx: AppContext) {
  const rl = requestRateLimit(ctx.chatLimiter, { bypass: ctx.isDevMode });
  // maxTotalSize is snapshot at route construction. Today filesConfig is
  // built once from startup config + defaults and never mutated; if that
  // invariant changes, make this limit lazy.
  const chatBodyLimit = bodyLimit(1_048_576, {
    multipart: ctx.runtime.getFilesConfig().maxTotalSize,
  });
  // A chat turn names the workspace it acts from. The send routes below
  // **require** `X-Workspace-Id` (`requireWorkspace` → `400` absent, `403`
  // non-member): the header is the load-bearing coordinate that picks the
  // BIRTH workspace of a new conversation (a resume re-resolves the
  // conversation's own workspace server-side, but a new turn has nothing else
  // to go on). It flows through `handleChat` into `ChatRequest.workspaceId`,
  // scoping tools and the prompt briefing to that one workspace; the
  // orchestrator's wall denies any other. See `handlers.ts::parseChatBody`.
  //
  // `requireWorkspace` is per-route and placed AFTER `chatBodyLimit`/`rl` so
  // body-limit and rate-limit still apply to a header-less request (those
  // middlewares' own tests don't send a workspace). `/cancel` carries no
  // workspace middleware — it's owner-gated by conversation id and needs none.
  return (
    new Hono<AppEnv>()
      .use("*", requireAuth(ctx.authOptions))
      .use("*", errorLog(ctx))
      .post("/v1/chat", chatBodyLimit, rl, requireWorkspace(ctx.workspaceStore), (c) =>
        handleChat(
          c.req.raw,
          ctx.runtime,
          ctx.features,
          c.var.identity,
          c.var.workspaceId,
          ctx.conversationEventManager,
        ),
      )
      .post("/v1/chat/stream", chatBodyLimit, rl, requireWorkspace(ctx.workspaceStore), (c) =>
        handleChatStream(
          c.req.raw,
          ctx.runtime,
          ctx.features,
          c.var.identity,
          c.var.workspaceId,
          ctx.conversationEventManager,
        ),
      )
      // Server-authoritative entry point: starts a detached turn and returns
      // the conversation id immediately. The client then watches via
      // GET /v1/conversations/:id/events. Generation survives client disconnect.
      .post("/v1/chat/start", chatBodyLimit, rl, requireWorkspace(ctx.workspaceStore), (c) =>
        handleChatStart(c.req.raw, ctx.runtime, ctx.features, c.var.identity, c.var.workspaceId),
      )
      // Explicit Stop — the only way to abort an in-flight turn.
      .post("/v1/conversations/:id/cancel", (c) =>
        handleChatCancel(c.req.param("id"), ctx.runtime, c.var.identity),
      )
  );
}
