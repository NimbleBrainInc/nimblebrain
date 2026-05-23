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
 *
 * Dev-mode: when no identity provider is configured (`bun run
 * dev:worktree`, `Runtime.start` without an `instance.json`), the
 * caller is treated as `DEV_IDENTITY` (`usr_default`) — same fallback
 * `runtime.chat` uses for the analogous case. Production deployments
 * with an identity provider configured but middleware that fails to
 * populate `c.var.identity` get a 401 (don't silently default to
 * usr_default and pool every user's reads).
 */

import { Hono } from "hono";
import { DEV_IDENTITY } from "../../identity/providers/dev.ts";
import { ConversationCorruptedError } from "../../runtime/errors.ts";
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

      // Resolve the caller id. Authenticated request → identity.id.
      // Dev mode (no identity provider configured) → fall back to
      // DEV_IDENTITY so the same conversations `runtime.chat` minted
      // under usr_default are readable. Misconfigured production
      // (provider exists but middleware didn't populate identity) →
      // 401 instead of pooling reads under a sentinel user.
      const callerId = identity?.id ?? (ctx.runtime.getIdentityProvider() ? null : DEV_IDENTITY.id);
      if (!callerId) {
        return apiError(401, "authentication_required", "Authentication required.");
      }

      // Two-step lookup so we can return 403 (not-yours) distinctly
      // from 404 (doesn't exist). Pass no access ctx to `findConversation`
      // — we want raw existence, then evaluate ownership ourselves.
      //
      // The store throws `ConversationCorruptedError` for pre-migration
      // files lacking `ownerId` (operator forgot one of the two
      // migrations). Map that to a clean 422 with the migration
      // command in the message instead of letting it bubble as 500.
      const conversation = await ctx.runtime.findConversation(conversationId).catch((err) => {
        if (err instanceof ConversationCorruptedError) {
          return err;
        }
        throw err;
      });
      if (conversation instanceof ConversationCorruptedError) {
        return apiError(422, "conversation_corrupted", conversation.message, {
          conversationId: conversation.conversationId,
          reason: conversation.reason,
        });
      }
      if (!conversation) {
        return apiError(404, "not_found", "Conversation not found");
      }
      if (conversation.ownerId !== callerId) {
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
      const { stream } = ctx.conversationEventManager.addSubscriber(conversationId, callerId);

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    });
}
