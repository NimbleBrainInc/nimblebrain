import type { Workspace } from "../workspace/types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { HOOK_ROTATION_GRACE_MS, type HookRegistration } from "./types.ts";

/**
 * Reading and writing hook registrations, which live on the workspace record.
 *
 * They sit beside `oauthOperatorApps` because they are the same kind of thing
 * in every dimension that matters: operator-plane, workspace-scoped, and with a
 * lifecycle that is related to but not identical to a bundle install. Putting
 * them there also makes the delivery path ONE read — the door already has to
 * load the workspace to resolve `bundles[]` into a forward target, and a
 * separate store would make it two on the one path the spec insists stays thin.
 *
 * The read-modify-write in `WorkspaceStore.update` races a concurrent install,
 * which is the race `oauthOperatorApps` already runs. It is not new here and
 * does not on its own justify a persistence layer.
 */

/** Composite key for a registration within a workspace. */
function keyOf(connector: string, vendor: string): string {
  return `${connector}/${vendor}`;
}

/** Find the registration for one `(connector, vendor)` in a workspace record. */
export function findRegistration(
  ws: Pick<Workspace, "hooks">,
  connector: string,
  vendor: string,
): HookRegistration | undefined {
  return ws.hooks?.[keyOf(connector, vendor)];
}

/** Every registration on a workspace record, as a stable-ordered list. */
export function listRegistrations(ws: Pick<Workspace, "hooks">): HookRegistration[] {
  return Object.values(ws.hooks ?? {}).sort((a, b) =>
    keyOf(a.connector, a.vendor).localeCompare(keyOf(b.connector, b.vendor)),
  );
}

/**
 * Whether a presented `kid` is admissible for a registration.
 *
 * Exactly two are: the current one, and the immediately-previous one while its
 * grace window is open. Anything else — a `kid` from two rotations ago, one
 * from another workspace, one invented — takes the identical rejection path, so
 * a prober learns nothing from the difference between "retired" and "never
 * existed".
 */
export function isKidAdmissible(
  reg: HookRegistration,
  kid: string,
  now: number = Date.now(),
): boolean {
  if (kid === reg.kid) return true;
  if (!reg.prevKid || kid !== reg.prevKid) return false;
  if (!reg.rotatedAt) return false;
  const rotatedAt = Date.parse(reg.rotatedAt);
  if (!Number.isFinite(rotatedAt)) return false;
  return now - rotatedAt < HOOK_ROTATION_GRACE_MS;
}

/**
 * Apply a mutation to one workspace's hook map and persist it.
 *
 * `mutate` receives the current map (a copy) and returns the next one, or
 * `null` to leave the record untouched — so a no-op revoke costs no write and
 * no `updatedAt` churn.
 */
export async function updateRegistrations(
  store: WorkspaceStore,
  wsId: string,
  mutate: (current: Record<string, HookRegistration>) => Record<string, HookRegistration> | null,
): Promise<Record<string, HookRegistration> | null> {
  const ws = await store.get(wsId);
  if (!ws) return null;
  const next = mutate({ ...(ws.hooks ?? {}) });
  if (next === null) return null;
  await store.update(wsId, { hooks: next });
  return next;
}

/**
 * Record a freshly-minted `kid` for one stream, rotating the previous one out.
 *
 * The same function serves the first mint and every rotation: on a first mint
 * there is no `prevKid` to carry, and on a rotation the outgoing `kid` becomes
 * `prevKid` with the rotation stamped. Keeping them one operation is what
 * guarantees a rotation can never lose the grace window by taking a different
 * code path.
 */
export function withRotatedKid(
  existing: HookRegistration | undefined,
  next: {
    connector: string;
    vendor: string;
    kid: string;
    route: string;
    headerRenames?: Record<string, string>;
  },
  nowIso: string = new Date().toISOString(),
): HookRegistration {
  const reg: HookRegistration = {
    connector: next.connector,
    vendor: next.vendor,
    kid: next.kid,
    createdAt: existing?.createdAt ?? nowIso,
    route: next.route,
  };
  if (next.headerRenames && Object.keys(next.headerRenames).length > 0) {
    reg.headerRenames = next.headerRenames;
  }
  if (existing) {
    reg.prevKid = existing.kid;
    reg.rotatedAt = nowIso;
  }
  return reg;
}

/** Registration map key, exported so callers building a map agree on it. */
export const registrationKey = keyOf;
