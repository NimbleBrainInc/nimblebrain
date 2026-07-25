import type { Context } from "hono";
import { canWriteWorkspaceScoped } from "../../workspace/authz.ts";
import { type AppContext, type AppEnv, apiError } from "../types.ts";

/**
 * Admission for the connector auth-initiate routes.
 *
 * A **first** connect is member-level. Someone has to authorise a connector an
 * admin installed, and until they do it holds no credential — so requiring
 * admin there would strand a workspace whose admin isn't the person with the
 * upstream account.
 *
 * A **re**-connect is not. Every auth flow on these routes binds the
 * *workspace's* shared credential (`WORKSPACE_PRINCIPAL_ID` for MCP OAuth, an
 * `owner: { type: "workspace" }` connected account for composio), so
 * re-running one replaces the identity every member's agent acts as upstream.
 * That is destructive in the same way `disconnect` is, and `disconnect` is
 * admin-gated.
 *
 * `handleConnectApiKey` already draws this line for the composio API-key path,
 * and its comment cites "matching the OAuth connect route" — these routes are
 * that route, catching up.
 *
 * `hasCredential` is passed as a thunk so each route supplies its own
 * purpose-built, side-effect-free existence check (`hasMcpOAuthTokens` /
 * `hasPersistedComposioConnection`) rather than this module reaching into two
 * storage layouts, and so the read is skipped entirely for an admin.
 *
 * Returns the refusal, or null to proceed.
 */
export async function requireAdminForReconnect(
  ctx: AppContext,
  c: Context<AppEnv>,
  wsId: string,
  hasCredential: () => boolean,
): Promise<Response | null> {
  const identity = c.var.identity;
  // `requireWorkspace` already established membership; an admin passes here
  // whether or not a credential exists, so the disk read is skipped for them.
  const ws = await ctx.workspaceStore.get(wsId);
  if (ws && canWriteWorkspaceScoped(identity, ws).allowed) return null;

  if (!hasCredential()) return null;

  return apiError(
    403,
    "workspace_admin_required",
    "This connector is already connected. Replacing the workspace's shared credential requires the workspace admin role.",
  );
}
