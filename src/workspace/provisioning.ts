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

  const existing = await store.get(wsId);
  if (existing) return existing;

  const name = identity.displayName ? `${identity.displayName}'s Workspace` : "Workspace";
  const slug = personalWorkspaceSlugFor(identity.id);

  try {
    return await store.create(name, slug, {
      isPersonal: true,
      ownerUserId: identity.id,
    });
  } catch (err) {
    if (err instanceof WorkspaceConflictError) {
      return reconcileConflict(store, wsId);
    }
    // A `PersonalWorkspaceInvariantError` from create() here would mean
    // the helper itself produced a bad-shape personal workspace — bug,
    // let it surface.
    if (err instanceof PersonalWorkspaceInvariantError) throw err;
    throw err;
  }
}

/**
 * A `create()` collision on the canonical personal-workspace id means
 * another concurrent call won the race. Re-read and return. Never create
 * a second workspace with a different slug — two personal workspaces per
 * user is exactly the bug the canonical-id model exists to prevent.
 */
async function reconcileConflict(store: WorkspaceStore, wsId: string): Promise<Workspace> {
  const existing = await store.get(wsId);
  if (existing) return existing;
  // WorkspaceConflictError fires only when store.get() returned non-null
  // inside create() — so reaching here means the workspace existed at
  // throw time and was deleted before our re-read (concurrent delete,
  // rare). Surface the inconsistency; callers retry.
  throw new Error(
    `[provisioning] personal workspace ${wsId} disappeared between create-conflict and re-read`,
  );
}
