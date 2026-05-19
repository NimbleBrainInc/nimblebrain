/**
 * Per-conversation SSE event stream route.
 *
 * GET /v1/conversations/:id/events
 *
 * Security: requireAuth → requireWorkspace → conversation access check (canAccess).
 * Access is re-validated on every subscription (not cached from page load).
 * Returns 404 for non-existent conversations (no existence leaks to unauthorized users).
 */

import { Hono } from "hono";
import { EventSourcedConversationStore } from "../../conversation/event-sourced-store.ts";
import { canAccess } from "../../conversation/index-cache.ts";
import { requireAuth } from "../middleware/auth.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requireWorkspace } from "../middleware/workspace.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

export function conversationEventRoutes(ctx: AppContext) {
  return new Hono<AppEnv>()
    .use("*", requireAuth(ctx.authOptions))
    .use("*", requireWorkspace(ctx.workspaceStore))
    .use("*", errorLog(ctx))
    .get("/v1/conversations/:id/events", async (c) => {
      const conversationId = c.req.param("id");
      const identity = c.var.identity;
      const workspaceId = c.var.workspaceId;

      // Resolve workspace-scoped conversation store via the typed handle.
      const wsConvDir = ctx.runtime.getWorkspaceContext(workspaceId).getDataPath("conversations");
      const store = new EventSourcedConversationStore({
        dir: wsConvDir,
        logLevel: "normal",
      });

      // Load conversation metadata
      const conversation = await store.load(conversationId);
      if (!conversation) {
        return apiError(404, "not_found", "Conversation not found");
      }

      // Stage 1 access check — single-owner. The conversation is
      // accessible iff the caller is its owner. Workspace-admin
      // overrides return in Stage 4 with explicit policy.
      if (!canAccess({ ownerId: conversation.ownerId }, { userId: identity.id })) {
        // Return 404 to avoid leaking conversation existence
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
