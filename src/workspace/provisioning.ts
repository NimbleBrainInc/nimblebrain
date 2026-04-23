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
 * This function establishes that invariant at the identity boundary —
 * call from each identity provider's first-login hook. Downstream code
 * (request resolvers, data handlers) may then treat the invariant as a
 * hard requirement.
 *
 * Behavior:
 * - User already a member of ≥1 workspace → return the first, no writes.
 * - User has no memberships → create a private workspace, add as admin.
 * - Concurrent first-login race (two calls for the same identity in flight)
 *   → resolved without creating duplicates: the loser catches the conflict,
 *   re-reads, and returns the winner's workspace (adding membership only if
 *   the winning workspace lacks it, which would indicate manual interference).
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
 * A create() collision on our deterministic slug means another call is
 * mid-flight (or completed) for the same identity. Recover by re-reading
 * and ensuring membership — never by creating a second workspace with a
 * different slug. Two workspaces per user from a race is the exact bug
 * the old timestamp-suffix fallback introduced.
 */
async function reconcileConflict(
  store: WorkspaceStore,
  identity: ProvisioningIdentity,
  wsId: string,
): Promise<Workspace> {
  const existing = await store.get(wsId);
  if (!existing) {
    // Conflict thrown but workspace missing on re-read — the other call
    // must have failed after creation. Retry membership on a fresh create.
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

/** Derive a workspace slug from a user ID. Matches the historical rule
 *  in the old resolveWorkspace auto-provision branch for backwards
 *  compatibility with any already-derived workspace IDs. */
function deriveSlug(userId: string): string {
  return userId
    .replace(/^user_/, "")
    .toLowerCase()
    .slice(0, 16);
}
