import { createMiddleware } from "hono/factory";
import { DEV_IDENTITY } from "../../identity/providers/dev.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";
import { isAddressedWorkspaceMember } from "../workspace-address.ts";

/** Path prefix of every workspace-scoped REST route: `/v1/workspaces/<wsId>/…`. */
export const WORKSPACE_ROUTE_PREFIX = "/v1/workspaces/:wsId";

/**
 * The one answer for a workspace this caller cannot reach: malformed, unknown,
 * or not theirs. `workspace_error` is the code the web shell recovers from.
 */
function workspaceNotFound(): Response {
  return apiError(404, "workspace_error", "Workspace not found");
}

/**
 * Admit a request to the workspace named by the route's `:wsId` and set it as
 * `c.var.workspaceId`. Runs after `requireAuth`. The check is the one `/mcp/<wsId>`
 * uses (`isAddressedWorkspaceMember`), on every request.
 *
 * With no identity on the request, the caller is the dev user only when no
 * identity provider is configured; otherwise (the internal connector token)
 * there is no member to admit.
 */
export function requireWorkspace(ctx: AppContext) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const wsId = c.req.param("wsId") ?? "";
    const callerId =
      c.var.identity?.id ?? (ctx.runtime.getIdentityProvider() ? null : DEV_IDENTITY.id);
    if (!callerId || !(await isAddressedWorkspaceMember(ctx.workspaceStore, wsId, callerId))) {
      return workspaceNotFound();
    }
    c.set("workspaceId", wsId);
    await next();
  });
}
