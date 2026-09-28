import { Hono } from "hono";
import { handleEvents } from "../handlers.ts";
import { requireAuth } from "../middleware/auth.ts";
import { errorLog } from "../middleware/error-log.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

/**
 * GET /v1/events — identity-scoped SSE event stream.
 *
 * Authorization is by identity, not by workspace. The handler computes
 * the caller's workspace memberships at connect time and caches them on
 * the SSE client; workspace-scoped events fan out only for member
 * workspaces, refreshed in-process when the workspace store fires a
 * `membershipChanged` (see `SseEventManager` and
 * `WorkspaceStore.onMembershipChanged`).
 *
 * A request with no identity gets a 401, never reads pooled under a
 * sentinel user — same posture as `/v1/conversations/:id/events`. The
 * `dev` identity provider verifies every request as `usr_default`, so
 * `bun run dev` passes like any other login.
 *
 * Middleware is chained per-route (not via `.use("*")`) so a future
 * sibling route mounted on this sub-app doesn't accidentally inherit
 * the auth chain — same precedent as `conversation-events.ts`.
 */
export function eventRoutes(ctx: AppContext) {
  return new Hono<AppEnv>().get(
    "/v1/events",
    requireAuth(ctx.authOptions),
    errorLog(ctx),
    async (c) => {
      const callerId = c.var.identity?.id;
      if (!callerId) {
        return apiError(401, "authentication_required", "Authentication required.");
      }
      return handleEvents(ctx.sseManager, ctx.workspaceStore, callerId);
    },
  );
}
