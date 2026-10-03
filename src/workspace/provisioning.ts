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
 * members can be added, and nothing records how it came to exist, or makes it
 * the one the user opens: which workspace to open is the URL's (ADR-0044).
 *
 * Concurrent calls for one user share one in-flight provisioning, so a burst
 * of first requests creates one workspace, not several. The guard is
 * per-process, which is enough at `replicas: 1` (see "Running more than one
 * replica" in `src/api/AGENTS.md`).
 */
export function ensureUserWorkspace(
  store: WorkspaceStore,
  identity: ProvisioningIdentity,
): Promise<Workspace[]> {
  let byUser = inflight.get(store);
  if (!byUser) {
    byUser = new Map();
    inflight.set(store, byUser);
  }
  const running = byUser.get(identity.id);
  if (running) return running;

  const run = provision(store, identity).finally(() => byUser.delete(identity.id));
  byUser.set(identity.id, run);
  return run;
}

async function provision(
  store: WorkspaceStore,
  identity: ProvisioningIdentity,
): Promise<Workspace[]> {
  const memberships = await store.getWorkspacesForUser(identity.id);
  if (memberships.length > 0) return memberships;

  const workspace = await store.create(provisionedWorkspaceName(identity.displayName), {
    members: [{ userId: identity.id, role: "admin" }],
  });
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
