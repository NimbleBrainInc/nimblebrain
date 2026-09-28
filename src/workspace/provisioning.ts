import type { UserPreferences, UserStore } from "../identity/user.ts";
import type { Workspace } from "./types.ts";
import type { WorkspaceStore } from "./workspace-store.ts";

/**
 * Minimal identity surface needed for workspace provisioning.
 * Kept narrow so callers don't need to thread a full UserIdentity.
 */
export interface ProvisioningIdentity {
  id: string;
  displayName?: string;
}

/** In-flight provisioning per store, keyed by user id. Entries live only while a call runs. */
const inflight = new WeakMap<WorkspaceStore, Map<string, Promise<Workspace[]>>>();

/**
 * Ensure the user belongs to at least one workspace, returning their
 * memberships (never empty).
 *
 * A user who belongs to none — new, or removed from every one — gets a
 * workspace named for them (`provisionedWorkspaceName`) with themselves as
 * admin. It is an ordinary workspace: an opaque id from `WorkspaceStore.create`,
 * members can be added, and nothing records how it came to exist. It becomes
 * the user's default workspace (`preferences.defaultWorkspaceId`) when a
 * `users` store is given.
 *
 * Concurrent calls for one user share one in-flight provisioning, so a burst
 * of first requests creates one workspace, not several. The guard is
 * per-process, which is enough at `replicas: 1` (see the `replicas > 1`
 * prerequisites in `src/api/AGENTS.md`).
 */
export function ensureUserWorkspace(
  store: WorkspaceStore,
  identity: ProvisioningIdentity,
  users?: UserStore,
): Promise<Workspace[]> {
  let byUser = inflight.get(store);
  if (!byUser) {
    byUser = new Map();
    inflight.set(store, byUser);
  }
  const running = byUser.get(identity.id);
  if (running) return running;

  const run = provision(store, identity, users).finally(() => byUser.delete(identity.id));
  byUser.set(identity.id, run);
  return run;
}

async function provision(
  store: WorkspaceStore,
  identity: ProvisioningIdentity,
  users: UserStore | undefined,
): Promise<Workspace[]> {
  const memberships = await store.getWorkspacesForUser(identity.id);
  if (memberships.length > 0) return memberships;

  const workspace = await store.create(provisionedWorkspaceName(identity.displayName), undefined, {
    members: [{ userId: identity.id, role: "admin" }],
  });
  if (users) {
    const user = await users.get(identity.id);
    if (user) {
      await users.update(identity.id, {
        preferences: { ...user.preferences, defaultWorkspaceId: workspace.id },
      });
    }
  }
  return [workspace];
}

/**
 * The name given to a workspace provisioned for a user: "Mat's workspace".
 * Takes the first word of the display name; a display name that is an email
 * address contributes its local part. With no usable name, "Workspace".
 */
export function provisionedWorkspaceName(displayName: string | undefined): string {
  const first = displayName?.trim().split(/\s+/)[0]?.split("@")[0];
  return first ? `${first}'s workspace` : "Workspace";
}

/**
 * The workspace a user lands in when nothing names one: their default
 * (`preferences.defaultWorkspaceId`) while they are still a member of it,
 * else their earliest membership. `memberships` must be non-empty and in
 * store order (`WorkspaceStore.list` sorts by `createdAt`).
 */
export function defaultWorkspaceFor(
  memberships: readonly Workspace[],
  preferences: UserPreferences | undefined,
): Workspace {
  const preferred = preferences?.defaultWorkspaceId;
  return memberships.find((ws) => ws.id === preferred) ?? memberships[0]!;
}
