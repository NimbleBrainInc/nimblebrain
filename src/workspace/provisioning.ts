import type { Workspace } from "./types.ts";
import {
  MemberConflictError,
  personalWorkspaceIdFor,
  personalWorkspaceSlugFor,
  WorkspaceConflictError,
  type WorkspaceStore,
} from "./workspace-store.ts";

/**
 * Minimal identity surface needed for workspace provisioning.
 * Kept narrow so callers don't need to thread a full UserIdentity.
 */
export interface ProvisioningIdentity {
  id: string;
  displayName?: string;
}

/**
 * Ensure the user has a personal workspace. Idempotent.
 *
 * Invariant (Stage 1+): every authenticated user owns exactly one personal
 * workspace at the canonical id `personalWorkspaceIdFor(user.id)`. The user
 * may additionally be a member of any number of shared workspaces; this
 * helper does not touch those.
 *
 * Providers call this on every successful verifyRequest so the invariant is
 * self-healing — any state drift (admin deletion, partial failure, users
 * migrated from a prior build) is corrected on next login.
 *
 * Behavior:
 * - Personal workspace exists at the canonical id, user is a member → no writes, return it.
 * - Personal workspace exists at the canonical id, user is NOT a member → add as admin, return.
 * - Personal workspace does not exist → create with `isPersonal: true` + `ownerUserId`, add user as admin.
 * - Concurrent first-login race → one winner creates, losers detect the conflict and re-read.
 *
 * Returns the user's personal workspace (always — never a shared one).
 */
export async function ensureUserWorkspace(
  store: WorkspaceStore,
  identity: ProvisioningIdentity,
): Promise<Workspace> {
  const wsId = personalWorkspaceIdFor(identity.id);

  const existing = await store.get(wsId);
  if (existing) {
    const isMember = existing.members.some((m) => m.userId === identity.id);
    if (isMember) return existing;
    // The workspace exists but the user isn't a member — defensive
    // self-heal. Should be rare: typically an admin accidentally removed
    // them, or a migration partial-applied. Re-add and continue.
    try {
      return await store.addMember(wsId, identity.id, "admin");
    } catch (err) {
      if (err instanceof MemberConflictError) {
        return (await store.get(wsId)) ?? existing;
      }
      throw err;
    }
  }

  const name = identity.displayName ? `${identity.displayName}'s Workspace` : "Workspace";
  const slug = personalWorkspaceSlugFor(identity.id);

  try {
    const ws = await store.create(name, slug, {
      isPersonal: true,
      ownerUserId: identity.id,
    });
    try {
      return await store.addMember(ws.id, identity.id, "admin");
    } catch (err) {
      // A loser of the create race can reach reconcileConflict and call
      // addMember before we do. Tolerate it: re-read and return.
      if (err instanceof MemberConflictError) {
        return (await store.get(ws.id)) ?? ws;
      }
      throw err;
    }
  } catch (err) {
    if (!(err instanceof WorkspaceConflictError)) throw err;
    return reconcileConflict(store, identity, wsId);
  }
}

/**
 * A `create()` collision on the canonical personal-workspace id means
 * another concurrent call won the race. Recover by re-reading and
 * ensuring membership. Never create a second workspace with a different
 * slug — two personal workspaces per user is exactly the bug the
 * canonical-id model exists to prevent.
 */
async function reconcileConflict(
  store: WorkspaceStore,
  identity: ProvisioningIdentity,
  wsId: string,
): Promise<Workspace> {
  const existing = await store.get(wsId);
  if (!existing) {
    // WorkspaceConflictError fires only when store.get() returned non-null
    // inside create() — so reaching here means the workspace existed at
    // throw time and was deleted before our re-read (concurrent delete,
    // rare). Recreate it.
    const ws = await store.create(
      identity.displayName ? `${identity.displayName}'s Workspace` : "Workspace",
      personalWorkspaceSlugFor(identity.id),
      { isPersonal: true, ownerUserId: identity.id },
    );
    return await store.addMember(ws.id, identity.id, "admin");
  }

  const isMember = existing.members.some((m) => m.userId === identity.id);
  if (isMember) return existing;

  try {
    return await store.addMember(existing.id, identity.id, "admin");
  } catch (err) {
    if (err instanceof MemberConflictError) {
      return (await store.get(existing.id)) ?? existing;
    }
    throw err;
  }
}
