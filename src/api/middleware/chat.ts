import { createMiddleware } from "hono/factory";
import { ChatDisabledError } from "../../runtime/errors.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

/** The answer of every chat route on an instance that offers no chat. */
export function chatDisabledResponse(): Response {
  return apiError(404, "chat_disabled", new ChatDisabledError().message);
}

/**
 * Admit a request to a chat route only when the instance offers chat: a plugin
 * implements the conversations contract (ADR-0076, chat is derived from the
 * contract). Otherwise the route answers `404 chat_disabled` before anything
 * else runs: on such an instance the route does not exist, and the code says
 * why. Chained first on each chat route, after `requireAuth`.
 */
export function requireChat(ctx: AppContext) {
  return createMiddleware<AppEnv>(async (_c, next) => {
    if (!ctx.runtime.isChatEnabled()) return chatDisabledResponse();
    await next();
  });
}
