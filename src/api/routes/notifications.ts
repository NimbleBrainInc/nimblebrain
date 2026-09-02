/**
 * Workspace notification inbox — replay.
 *
 * `GET /v1/workspaces/:id/notifications?after=<seq>&limit=<n>`
 *
 * `/v1/events` carries `notification.created` live, but it has no
 * `Last-Event-Id` and nothing survives a disconnect, so a tab opened tomorrow
 * would see none of today's items. This route is the replay half: items in
 * ascending `seq` order, resumed from the highest one the client already holds.
 *
 * The workspace is in the PATH here rather than the `X-Workspace-Id` header,
 * because the resource is a workspace's inbox rather than something read
 * "inside" a workspace, and a browser refetching after a reconnect names the
 * inbox it is holding. Naming it does not reach it: membership of the named
 * workspace is checked on every request, exactly as `resolveWorkspace` checks
 * the header form.
 *
 * Denials are uniform. An unknown workspace and a workspace the caller is not
 * a member of both answer `403` with the same body — distinguishing them would
 * turn this route into an existence oracle for workspace ids, and "you are not
 * a member" is true of both.
 */

import { Hono } from "hono";
import { DEV_IDENTITY } from "../../identity/providers/dev.ts";
import { toNotificationView } from "../../notifications/view.ts";
import {
  NOTIFICATION_LIST_MAX_LIMIT,
  type NotificationsListOutput,
} from "../../tools/platform/schemas/notifications.ts";
import { WORKSPACE_ID_RE } from "../auth-middleware.ts";
import { requireAuth } from "../middleware/auth.ts";
import { errorLog } from "../middleware/error-log.ts";
import { type AppContext, type AuthEnv, apiError } from "../types.ts";

/** Page size when the client names none. */
const DEFAULT_LIMIT = 50;

/** Parse an integer query parameter at or above `min`, else `undefined`. */
function parseCount(raw: string | undefined, min: number): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= min ? value : undefined;
}

export function notificationRoutes(ctx: AppContext) {
  // Middleware chained on the route itself, not via `.use("*")`: a sub-app's
  // wildcard middleware flattens into a `/*` matcher that runs for every later
  // request reaching the parent. Same precedent as `conversation-events.ts`.
  return new Hono<AuthEnv>().get(
    "/v1/workspaces/:id/notifications",
    requireAuth(ctx.authOptions),
    errorLog(ctx),
    async (c) => {
      const wsId = c.req.param("id");
      if (!WORKSPACE_ID_RE.test(wsId)) {
        return apiError(400, "bad_request", "Invalid workspace ID format.");
      }

      // Dev mode (no identity provider) resolves to the same sentinel every
      // other read route uses. A configured provider whose middleware left no
      // identity is a 401, never a silent pool under the sentinel.
      const callerId =
        c.var.identity?.id ?? (ctx.runtime.getIdentityProvider() ? null : DEV_IDENTITY.id);
      if (!callerId) {
        return apiError(401, "authentication_required", "Authentication required.");
      }

      const workspace = await ctx.workspaceStore.get(wsId);
      if (!workspace?.members.some((m) => m.userId === callerId)) {
        return apiError(403, "workspace_error", `Access denied: not a member of "${wsId}".`);
      }

      const after = parseCount(c.req.query("after"), 0) ?? 0;
      const limit = Math.min(
        parseCount(c.req.query("limit"), 1) ?? DEFAULT_LIMIT,
        NOTIFICATION_LIST_MAX_LIMIT,
      );
      const items = ctx.runtime.getNotificationStore(wsId).since(after, limit);
      const notifications = items.map(toNotificationView);
      const body: NotificationsListOutput = {
        notifications,
        ...(notifications.length > 0
          ? { cursor: notifications[notifications.length - 1]!.seq }
          : {}),
      };
      return Response.json(body);
    },
  );
}
