import type { Workspace } from "./types.ts";
import {
  MemberConflictError,
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
 * Ensure the user has at least one workspace. Idempotent.
 *
 * Invariant for the system: every authenticated user has ≥1 workspace.
 * Providers call this on every successful verifyRequest so the invariant
 * is self-healing — any state drift (admin deletion, partial failure,
 * users migrated from a prior build) is corrected on next login instead
 * of causing a permanent 500.
 *
 * Behavior:
 * - User already a member of ≥1 workspace → return the first, no writes.
 * - User has no memberships → create a private workspace, add as admin.
 * - Concurrent first-login race (two calls for the same identity in flight)
 *   → resolved without creating duplicates. One race winner completes both
 *   create and addMember; losers either see the committed workspace via
 *   getWorkspacesForUser, or catch WorkspaceConflictError / MemberConflictError
 *   and re-read. No same-user race produces more than one workspace.
 *
 * Concurrency note: WorkspaceStore.create is read-then-write without a
 * filesystem lock, so `create` only detects conflicts where the first
 * writer already committed. This helper's safety comes from (a) slugs
 * being derived from the full user ID — different users cannot collide —
 * and (b) same-user races converging on the same addMember target.
 */
export async function ensureUserWorkspace(
  store: WorkspaceStore,
  identity: ProvisioningIdentity,
): Promise<Workspace> {
  const existing = await store.getWorkspacesForUser(identity.id);
  if (existing.length > 0) {
    return existing[0]!;
  }

  const slug = deriveSlug(identity.id);
  const name = identity.displayName ? `${identity.displayName}'s Workspace` : "Workspace";

  try {
    const ws = await store.create(name, slug);
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
    return reconcileConflict(store, identity, `ws_${slug}`);
  }
}

/**
 * A create() collision on our deterministic slug means another concurrent
 * call is mid-flight for the same identity — with full (untruncated) user
 * IDs as slugs, no two different users can collide here. Recover by
 * re-reading and ensuring membership. Never create a second workspace with
 * a different slug: two workspaces per user from a race is the exact bug
 * the old timestamp-suffix fallback introduced.
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
      deriveSlug(identity.id),
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

/**
 * Derive a workspace slug from a user ID.
 *
 * Uses the full (prefix-stripped) user ID with NO truncation. The old
 * `.slice(0, 16)` inherited from resolveWorkspace left only ~7 hex chars
 * of entropy for OIDC IDs (`usr_oidc_<12 hex>` → `usr_oidc_<7 hex>`),
 * producing a birthday collision at ~16K users. On collision, the
 * reconcile path would silently add two unrelated users as admins of
 * the same workspace — a security bug. WORKSPACE_ID_RE permits 64 chars
 * so there is no reason to truncate.
 */
function deriveSlug(userId: string): string {
  return userId.replace(/^user_/, "").toLowerCase();
}
