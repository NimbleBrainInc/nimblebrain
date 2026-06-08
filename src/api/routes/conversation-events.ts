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
import { CONVERSATION_ID_RE } from "../../conversation/types.ts";
import { DEV_IDENTITY } from "../../identity/providers/dev.ts";
import { ConversationCorruptedError } from "../../runtime/errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { errorLog } from "../middleware/error-log.ts";
import { optionalWorkspace } from "../middleware/workspace.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

export function conversationEventRoutes(ctx: AppContext) {
  // Middleware is chained on the route itself, NOT via `.use("*")`. Hono
  // flattens a sub-app's `.use("*")` into a `/*` matcher that runs for
  // EVERY request reaching the parent after this sub-app is mounted —
  // including sibling routes like `/v1/bootstrap`. That leak made
  // `optionalWorkspace`'s membership check (403 for a non-member
  // `X-Workspace-Id`) fire on the *permissive* bootstrap route, locking
  // out any user whose remembered workspace they'd lost access to.
  // Per-route middleware scopes enforcement to exactly this path — same
  // precedent as `mcp-auth.ts` (per-handler, not `.use("*")`).
  return new Hono<AppEnv>().get(
    "/v1/conversations/:id/events",
    requireAuth(ctx.authOptions),
    optionalWorkspace(ctx.workspaceStore),
    errorLog(ctx),
    async (c) => {
      const conversationId = c.req.param("id");
      // Reject a malformed id with 400 before it reaches the store, where
      // `validateConversationId` would throw a plain Error that bubbles to a
      // 500. Mirrors the `/v1/chat/start` schema guard so a typo or a
      // path-traversal probe gets a clean bad-request, not a 5xx.
      if (!CONVERSATION_ID_RE.test(conversationId)) {
        return apiError(400, "bad_request", "Invalid conversationId format");
      }
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

      // Resume point: the client passes the highest sequence number it has
      // already rendered (0 / absent = full replay of the in-flight turn).
      const afterSeqRaw = c.req.query("afterSeq");
      const afterSeq = afterSeqRaw ? Number.parseInt(afterSeqRaw, 10) : 0;
      const replay = ctx.runtime.getTurnReplay(
        conversationId,
        Number.isFinite(afterSeq) ? afterSeq : 0,
      );

      // Create the SSE stream. The manager replays the buffered in-flight turn
      // (events with seq > afterSeq) before registering for live fan-out, so a
      // page refresh reconstructs the in-progress assistant message and then
      // tails the rest with no gap or duplication.
      const { stream } = ctx.conversationEventManager.addSubscriber(
        conversationId,
        callerId,
        replay,
        {
          isActive: ctx.runtime.isTurnActive(conversationId),
          activeSeq: ctx.runtime.turnSeq(conversationId),
        },
      );

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    },
  );
}
