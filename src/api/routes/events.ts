import { Hono } from "hono";
import { DEV_IDENTITY } from "../../identity/providers/dev.ts";
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
 * Dev-mode parity: when no identity provider is configured, fall back
 * to `DEV_IDENTITY` (`usr_default`) so `bun run dev` works without an
 * auth gate. Misconfigured production (provider exists but middleware
 * didn't populate `c.var.identity`) → 401 instead of silently pooling
 * reads under the sentinel user — same posture as
 * `/v1/conversations/:id/events`.
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
      const identity = c.var.identity;
      const callerId = identity?.id ?? (ctx.runtime.getIdentityProvider() ? null : DEV_IDENTITY.id);
      if (!callerId) {
        return apiError(401, "authentication_required", "Authentication required.");
      }
      return handleEvents(ctx.sseManager, ctx.workspaceStore, callerId);
    },
  );
}
