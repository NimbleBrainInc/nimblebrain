import { Hono } from "hono";
import { handleChat, handleChatStream } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requestRateLimit } from "../middleware/rate-limit.ts";
import { optionalWorkspace } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

export function chatRoutes(ctx: AppContext) {
  const rl = requestRateLimit(ctx.chatLimiter);
  // maxTotalSize is snapshot at route construction. Today filesConfig is
  // built once from startup config + defaults and never mutated; if that
  // invariant changes, make this limit lazy.
  const chatBodyLimit = bodyLimit(1_048_576, {
    multipart: ctx.runtime.getFilesConfig().maxTotalSize,
  });
  // Stage 2 (T006): `/v1/chat` is identity-bound. We use the optional
  // workspace middleware so an `X-Workspace-Id` header (sent by web
  // composer and existing automations clients) still validates against
  // membership (`400/403` on a malformed or cross-tenant header), but
  // its value never reaches the chat handler — `handleChat` discards
  // it. The chat session's tool list comes from
  // `aggregateToolList(identityId)` and each call routes via the
  // orchestrator. See `handlers.ts::parseChatBody` for the
  // accept-but-ignore docstring.
  return new Hono<AppEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .use("*", optionalWorkspace(ctx.workspaceStore))
    .use("*", errorLog(ctx))
    .post("/v1/chat", chatBodyLimit, rl, (c) =>
      handleChat(
        c.req.raw,
        ctx.runtime,
        ctx.features,
        c.var.identity,
        c.var.workspaceId,
        ctx.conversationEventManager,
      ),
    )
    .post("/v1/chat/stream", chatBodyLimit, rl, (c) =>
      handleChatStream(
        c.req.raw,
        ctx.runtime,
        ctx.features,
        c.var.identity,
        c.var.workspaceId,
        ctx.conversationEventManager,
      ),
    );
}
