import type { UserStore } from "../identity/user.ts";
import { log } from "../observability/log.ts";
import { provisionedWorkspaceName } from "./provisioning.ts";
import type { Workspace } from "./types.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

/**
 * Remove `isPersonal` / `ownerUserId` from workspace records at boot. Idempotent.
 *
 * No code honors those fields — every workspace is ordinary (ADR-0039) — so
 * this reconcile is where they leave the records that carry them. For each
 * record with `isPersonal: true` and an `ownerUserId`, before the fields go:
 *
 * - it is renamed to `provisionedWorkspaceName(owner.displayName)` when it
 *   is named exactly `"<displayName>'s Workspace"`. Any other name is kept;
 * - its owner is seated as admin when missing from its member list.
 *
 * It never touches the id. It runs after `assertWorkspaceIdsConform`, so
 * every record it reads already carries a generated id, and it reads none of
 * an id's characters: the owner comes from `ownerUserId`, never from the id.
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
 * Settle the owner a record names: the workspace's name and their seat.
 * Returns the name to keep.
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
    if (workspace.name === `${owner.displayName}'s Workspace`) {
      name = provisionedWorkspaceName(owner.displayName);
    }
  }
  // The owner's data in this workspace is reachable only through membership,
  // so an owner missing from the list is seated as admin.
  if (!workspace.members.some((m) => m.userId === ownerUserId)) {
    await store.addMember(workspace.id, ownerUserId, "admin");
  }
  return name;
}
