import { Hono } from "hono";
import { handleChat, handleChatStream } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requestRateLimit } from "../middleware/rate-limit.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import type { AppContext, AppEnv } from "../types.ts";

export function chatRoutes(ctx: AppContext) {
  const rl = requestRateLimit(ctx.chatLimiter);
  return new Hono<AppEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .use("*", requireWorkspace(ctx.workspaceStore))
    .use("*", errorLog(ctx))
    .post("/v1/chat", rl, (c) =>
      handleChat(c.req.raw, ctx.runtime, ctx.features, c.var.identity, c.var.workspaceId),
    )
    .post("/v1/chat/stream", rl, (c) =>
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
