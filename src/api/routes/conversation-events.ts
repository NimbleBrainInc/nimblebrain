/**
 * Per-conversation SSE event stream route.
 *
 * GET /v1/conversations/:id/events
 *
 * Security: requireAuth → conversation access check via store-layer
 * access context. Access is re-validated on every subscription (not
 * cached from page load). Returns 404 for non-existent OR
 * not-owned conversations — no existence leaks to unauthorized users.
 *
 * `requireWorkspace` middleware is intentionally absent: conversations
 * live at the user level post-Stage 1 and don't need an
 * `X-Workspace-Id` header to be located. The route still requires auth.
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";
import { errorLog } from "../middleware/error-log.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

export function conversationEventRoutes(ctx: AppContext) {
  return new Hono<AppEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .use("*", errorLog(ctx))
    .get("/v1/conversations/:id/events", async (c) => {
      const conversationId = c.req.param("id");
      const identity = c.var.identity;

      // Stage 1 access check happens inline at the store layer:
      // `findConversation` with an access context returns null for
      // both "doesn't exist" and "exists but not yours". One branch,
      // same 404 — no existence leak.
      const conversation = await ctx.runtime.findConversation(conversationId, {
        userId: identity.id,
      });
      if (!conversation) {
        return apiError(404, "not_found", "Conversation not found");
      }

      // Create SSE stream for this subscriber
      const stream = ctx.conversationEventManager.addSubscriber(conversationId, identity.id);

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    });
}
