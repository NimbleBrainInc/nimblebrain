/**
 * Per-conversation SSE event stream route.
 *
 * GET /v1/workspaces/:wsId/conversations/:id/events
 *
 * Security: requireAuth → requireChat (`404 chat_disabled` when no plugin
 * implements the conversations contract) → requireWorkspace (membership of the
 * workspace in the path) → the caller's own conversation in that workspace.
 *
 * The workspace in the path is the only place the conversation is looked
 * for: no conversation read crosses a workspace. An unknown id, another
 * owner's conversation, and one the caller holds in another workspace all
 * answer `404 conversation_not_found`, so the answer reveals neither
 * existence nor location. A conversation the conversations plugin cannot read
 * answers `422 conversation_corrupted`.
 */

import { Hono } from "hono";
import { CONVERSATION_ID_RE } from "../../conversation/types.ts";
import { ConversationCorruptedError } from "../../runtime/errors.ts";
import { conversationCorruptedResponse } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireChat } from "../middleware/chat.ts";
import { errorLog } from "../middleware/error-log.ts";
import { requireWorkspace, WORKSPACE_ROUTE_PREFIX } from "../middleware/workspace.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

/**
 * Look up one of `callerId`'s conversations in `workspaceId`, surfacing a
 * `ConversationCorruptedError` as a value instead of a throw.
 */
async function findConversationOrCorrupted(
  ctx: AppContext,
  workspaceId: string,
  conversationId: string,
  callerId: string,
) {
  return ctx.runtime
    .findConversation(workspaceId, conversationId, { userId: callerId })
    .catch((err) => {
      if (err instanceof ConversationCorruptedError) {
        return err;
      }
      throw err;
    });
}

/** Parse the client's `afterSeq` resume cursor, defaulting to 0 for absent or non-finite input. */
function parseAfterSeq(raw: string | undefined): number {
  const afterSeq = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(afterSeq) ? afterSeq : 0;
}

/** Wrap an SSE stream in a `Response` with event-stream headers. */
function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function conversationEventRoutes(ctx: AppContext) {
  // Middleware is chained on the route itself, NOT via `.use("*")`. Hono
  // flattens a sub-app's `.use("*")` into a `/*` matcher that runs for
  // EVERY request reaching the parent after this sub-app is mounted —
  // including sibling routes like `/v1/bootstrap`. Per-route middleware
  // scopes enforcement to exactly this path — same precedent as
  // `mcp-auth.ts` (per-handler, not `.use("*")`).
  return new Hono<AppEnv>().get(
    `${WORKSPACE_ROUTE_PREFIX}/conversations/:id/events`,
    requireAuth(ctx.authOptions),
    requireChat(ctx),
    errorLog(ctx),
    requireWorkspace(ctx),
    async (c) => {
      const conversationId = c.req.param("id");
      // Reject a malformed id with 400 before it reaches the store, where
      // `validateConversationId` would throw a plain Error that bubbles to a
      // 500. Mirrors the `/v1/workspaces/:wsId/chat/start` schema guard so a typo or a
      // path-traversal probe gets a clean bad-request, not a 5xx.
      if (!CONVERSATION_ID_RE.test(conversationId)) {
        return apiError(400, "bad_request", "Invalid conversationId format");
      }

      // `requireWorkspace` admitted only an identified member, so the
      // identity is present here.
      const callerId = c.var.identity?.id;
      if (!callerId) {
        return apiError(401, "authentication_required", "Authentication required.");
      }

      const conversation = await findConversationOrCorrupted(
        ctx,
        c.var.workspaceId,
        conversationId,
        callerId,
      );
      if (conversation instanceof ConversationCorruptedError) {
        return conversationCorruptedResponse(conversation);
      }
      if (!conversation) {
        return apiError(404, "conversation_not_found", "Conversation not found", {
          conversationId,
        });
      }

      // Resume point: the client passes the highest sequence number it has
      // already rendered (0 / absent = full replay of the in-flight turn).
      const afterSeq = parseAfterSeq(c.req.query("afterSeq"));
      const replay = ctx.runtime.getTurnReplay(conversationId, afterSeq);

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

      return sseResponse(stream);
    },
  );
}
