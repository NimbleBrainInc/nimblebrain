import { PersonalWorkspaceInvariantError } from "./errors.ts";
import type { Workspace } from "./types.ts";
import {
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
 * self-healing — any state drift (workspace missing, partial-applied
 * migration) is corrected on next login.
 *
 * Behavior:
 * - Personal workspace exists at the canonical id → return it. The store's
 *   create-time invariant guarantees the owner is the sole admin member;
 *   we don't second-guess that here.
 * - Personal workspace does not exist → create with `isPersonal: true` +
 *   `ownerUserId`, which `WorkspaceStore.create` populates with the
 *   owner-admin member.
 * - Concurrent first-login race → one winner creates, losers detect the
 *   conflict and re-read.
 *
 * Returns the user's personal workspace (always — never a shared one).
 *
 * Pre-Stage-1.1 state (the user exists but their personal workspace's
 * member list isn't the canonical sole-owner-admin) is NOT auto-healed
 * here. The membership invariant is now enforced by the store; bumping
 * it from a login hot-path would silently mutate identity-bound state.
 * Operators recover via `scripts/cleanup-personal-workspace-members.ts`.
 */
export async function ensureUserWorkspace(
  store: WorkspaceStore,
  identity: ProvisioningIdentity,
): Promise<Workspace> {
  const wsId = personalWorkspaceIdFor(identity.id);
  const name = identity.displayName ? `${identity.displayName}'s Workspace` : "Workspace";
  const slug = personalWorkspaceSlugFor(identity.id);

  // Self-healing read-then-create loop. The body covers three race
  // shapes around the canonical id: (a) another caller already created
  // it (read wins); (b) we lose a create-conflict and the workspace
  // exists by the time we re-read (loop returns it); (c) we lose a
  // create-conflict but the workspace was deleted before re-read (loop
  // recreates). 3 attempts is plenty — (c) twice in a row would
  // require pathological concurrent create+delete churn on one user.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await store.get(wsId);
    if (existing) return existing;
    try {
      return await store.create(name, slug, {
        isPersonal: true,
        ownerUserId: identity.id,
      });
    } catch (err) {
      if (err instanceof WorkspaceConflictError) continue;
      // `PersonalWorkspaceInvariantError` here would mean this helper
      // built a bad-shape personal workspace — a bug, not a race.
      // Anything else: surface unchanged.
      if (err instanceof PersonalWorkspaceInvariantError) throw err;
      throw err;
    }
  }

  throw new Error(
    `[provisioning] personal workspace ${wsId} couldn't be reconciled after ${MAX_ATTEMPTS} attempts — investigate concurrent create/delete activity`,
  );
}
