/**
 * Per-conversation SSE event stream route.
 *
 * GET /v1/conversations/:id/events
 *
 * Security: requireAuth → requireWorkspace → conversation access check (canAccess).
 * Access is re-validated on every subscription (not cached from page load).
 * Returns 404 for non-existent conversations (no existence leaks to unauthorized users).
 */

import { join } from "node:path";
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

      // Resolve workspace-scoped conversation store
      const workDir = ctx.runtime.getWorkDir();
      const wsConvDir = join(workDir, "workspaces", workspaceId, "conversations");
      const store = new EventSourcedConversationStore({
        dir: wsConvDir,
        logLevel: "normal",
      });

      // Load conversation metadata
      const conversation = await store.load(conversationId);
      if (!conversation) {
        return apiError(404, "not_found", "Conversation not found");
      }

      // Determine workspace role for the requesting user
      const workspace = await ctx.workspaceStore.get(workspaceId);
      const member = workspace?.members.find((m) => m.userId === identity.id);
      const workspaceRole = member?.role === "admin" ? ("admin" as const) : ("member" as const);

      // Check conversation access
      const accessMeta = {
        ownerId: conversation.ownerId,
        visibility: conversation.visibility,
        participants: conversation.participants,
      };
      if (
        !canAccess(accessMeta, {
          userId: identity.id,
          workspaceRole,
        })
      ) {
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
