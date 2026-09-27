import type { UserStore } from "../identity/user.ts";
import { log } from "../observability/log.ts";
import { provisionedWorkspaceName } from "./provisioning.ts";
import type { Workspace } from "./types.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

/**
 * Retire the legacy personal-workspace fields at boot. Idempotent.
 *
 * The workspace provisioned for a user was once a sole-owner "personal"
 * workspace, marked on disk with `isPersonal` and `ownerUserId`. Every
 * workspace is now ordinary, so no code reads those fields; this reconcile is
 * where they leave. For each former personal workspace, before its fields go:
 *
 * - the owner's `preferences.defaultWorkspaceId` is set to it when unset, so
 *   the owner keeps landing where they always have;
 * - it is renamed to `provisionedWorkspaceName(owner.displayName)` when it
 *   still carries exactly the name provisioning used to give it
 *   (`"<displayName>'s Workspace"`). A name anyone edited is kept;
 * - its owner is seated as admin when missing from its member list.
 *
 * Its id stays as it is. Ids are opaque, and a former personal workspace's id
 * is in URLs and MCP client configurations that a rename would break.
 *
 * Runs before anything serves, so no request sees a half-retired record. A
 * crash midway leaves the fields on the records not yet written, and the next
 * boot finishes them.
 */
export async function retireLegacyPersonalWorkspaces(
  store: WorkspaceStore,
  users: UserStore,
): Promise<void> {
  const legacy = await store.listLegacyPersonal();
  for (const { workspace, ownerUserId } of legacy) {
    const name = ownerUserId
      ? await settleOwner(store, users, workspace, ownerUserId)
      : workspace.name;
    // `update` drops the legacy fields on write, so it runs even when the
    // name is unchanged.
    await store.update(workspace.id, { name });
  }
  if (legacy.length > 0) {
    log.info(`[workspace] retired legacy personal fields on ${legacy.length} workspace(s)`);
  }
}

/**
 * Carry a former personal workspace's owner over: their default, the
 * workspace's provisioned name, and their seat. Returns the name to keep.
 */
async function settleOwner(
  store: WorkspaceStore,
  users: UserStore,
  workspace: Workspace,
  ownerUserId: string,
): Promise<string> {
  let name = workspace.name;
  const owner = await users.get(ownerUserId);
  if (owner) {
    if (!owner.preferences.defaultWorkspaceId) {
      await users.update(ownerUserId, {
        preferences: { ...owner.preferences, defaultWorkspaceId: workspace.id },
      });
    }
    if (workspace.name === `${owner.displayName}'s Workspace`) {
      name = provisionedWorkspaceName(owner.displayName);
    }
  }
  // A personal workspace's owner was a member by rule, and access checks
  // assumed it without reading the list. Where the list lost them, seat
  // them as admin, or the owner would be locked out of their own data.
  if (!workspace.members.some((m) => m.userId === ownerUserId)) {
    await store.addMember(workspace.id, ownerUserId, "admin");
  }
  return name;
}
