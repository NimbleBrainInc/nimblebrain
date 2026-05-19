/**
 * Per-conversation SSE event stream route.
 *
 * GET /v1/conversations/:id/events
 *
 * Security: requireAuth → optionalWorkspace → ownership check.
 *
 * Workspace is *optional* (Task 006): conversations are user-owned
 * post-Stage-1, so a conversation read is authorized by ownership, not
 * workspace membership. If `X-Workspace-Id` is sent, we still validate
 * it (malformed → 400, non-member → 403) so a chat-UI client that
 * sends the header on every call doesn't need to special-case this
 * route.
 *
 * Response shape:
 *  - Conversation doesn't exist → 404 `not_found`.
 *  - Conversation exists but the caller isn't the owner → 403
 *    `conversation_access_denied`. The caller has authenticated and
 *    supplied a specific id; leaking existence vs not is fine in that
 *    posture (matches the `ConversationAccessDeniedError` mapping on
 *    the chat path). Content does not leak.
 *  - Conversation exists and the caller is the owner → 200 SSE.
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";
import { errorLog } from "../middleware/error-log.ts";
import { optionalWorkspace } from "../middleware/workspace.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

export function conversationEventRoutes(ctx: AppContext) {
  return new Hono<AppEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .use("*", optionalWorkspace(ctx.workspaceStore))
    .use("*", errorLog(ctx))
    .get("/v1/conversations/:id/events", async (c) => {
      const conversationId = c.req.param("id");
      const identity = c.var.identity;

      // Two-step lookup so we can return 403 (not-yours) distinctly
      // from 404 (doesn't exist). Pass no access ctx to `findConversation`
      // — we want raw existence, then evaluate ownership ourselves.
      const conversation = await ctx.runtime.findConversation(conversationId);
      if (!conversation) {
        return apiError(404, "not_found", "Conversation not found");
      }
      if (conversation.ownerId !== identity.id) {
        return apiError(
          403,
          "conversation_access_denied",
          "You do not have access to this conversation.",
          {
            conversationId,
          },
        );
      }

      // Create SSE stream for this subscriber. The first frame
      // (event: subscribed) carries the server-generated subscriberId
      // so the client can pass it back as `X-Origin-Subscriber-Id` on
      // any chat-stream POST it originates — that prevents the
      // chat-stream's broadcast from echoing back to this same
      // subscription.
      const { stream } = ctx.conversationEventManager.addSubscriber(conversationId, identity.id);

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    });
}
