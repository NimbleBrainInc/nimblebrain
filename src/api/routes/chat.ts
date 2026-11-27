import { Hono } from "hono";
import { handleChatCancel, handleChatStart } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { requireChat } from "../middleware/chat.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requestRateLimit } from "../middleware/rate-limit.ts";
import { requireWorkspace, WORKSPACE_ROUTE_PREFIX } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

export function chatRoutes(ctx: AppContext) {
  const rl = requestRateLimit(ctx.chatLimiter);
  // maxTotalSize is snapshot at route construction. Today filesConfig is
  // built once from startup config + defaults and never mutated; if that
  // invariant changes, make this limit lazy.
  const chatBodyLimit = bodyLimit(1_048_576, {
    multipart: ctx.runtime.getFilesConfig().maxTotalSize,
  });
  // A chat turn acts from the workspace in its URL. For a new conversation that
  // is the birth workspace; a resume re-resolves the conversation's own
  // workspace server-side. It flows through `handleChatStart` into
  // `ChatRequest.workspaceId`, scoping tools and the prompt briefing to that one
  // workspace; the orchestrator's wall denies any other. See
  // `handlers.ts::parseChatBody`.
  //
  // `requireWorkspace` is per-route and placed AFTER `chatBodyLimit`/`rl` so
  // body-limit and rate-limit apply before the workspace lookup. `/cancel`
  // finds the conversation only in the caller's partition of the workspace in
  // its path, like every conversation read.
  const auth = requireAuth(ctx.authOptions);
  // Chat is on only while a plugin implements the conversations contract;
  // otherwise both routes answer `404 chat_disabled`.
  const chat = requireChat(ctx);
  const logErrors = errorLog(ctx);
  return (
    new Hono<AppEnv>()
      // Server-authoritative entry point: starts a detached turn and returns
      // the conversation id immediately. The client then watches via
      // GET /v1/workspaces/:wsId/conversations/:id/events. Generation survives
      // client disconnect.
      .post(
        `${WORKSPACE_ROUTE_PREFIX}/chat/start`,
        auth,
        chat,
        logErrors,
        chatBodyLimit,
        rl,
        requireWorkspace(ctx),
        (c) => handleChatStart(c.req.raw, ctx.runtime, c.var.identity, c.var.workspaceId),
      )
      // Explicit Stop — the only way to abort an in-flight turn.
      .post(
        `${WORKSPACE_ROUTE_PREFIX}/conversations/:id/cancel`,
        auth,
        chat,
        logErrors,
        requireWorkspace(ctx),
        (c) => handleChatCancel(c.req.param("id"), ctx.runtime, c.var.identity, c.var.workspaceId),
      )
  );
}
