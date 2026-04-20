import { Hono } from "hono";
import { handleChat, handleChatStream } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { bodyLimit } from "../middleware/body-limit.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requestRateLimit } from "../middleware/rate-limit.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

export function chatRoutes(ctx: AppContext) {
  const rl = requestRateLimit(ctx.chatLimiter);
  // maxTotalSize is snapshot at route construction. Today filesConfig is
  // built once from startup config + defaults and never mutated; if that
  // invariant changes, make this limit lazy.
  const chatBodyLimit = bodyLimit(1_048_576, {
    multipart: ctx.runtime.getFilesConfig().maxTotalSize,
  });
  return new Hono<AppEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .use("*", requireWorkspace(ctx.workspaceStore))
    .use("*", errorLog(ctx))
    .post("/v1/chat", chatBodyLimit, rl, (c) =>
      handleChat(c.req.raw, ctx.runtime, ctx.features, c.var.identity, c.var.workspaceId),
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
