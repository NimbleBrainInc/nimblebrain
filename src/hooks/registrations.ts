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
 * Writes are SERIALIZED PER WORKSPACE (`updateRegistrations`), and that is not
 * optional. `oauthOperatorApps` shares the read-modify-write shape and does not
 * serialize, so the comparison invites dropping the lock — it does not hold,
 * because the two lose different things. A lost `oauthOperatorApps` write costs
 * an operator a repeated action they can see failed. A lost hooks write costs a
 * dead inbound stream: the server has already been handed a URL whose `kid`
 * exists nowhere, so every delivery on it 404s silently, with a healthy-looking
 * registration on the far side and no error anywhere.
 *
 * The race is on the ordinary path, not an exotic one — boot seeds every
 * workspace bundle in a synchronous loop with the connection observer armed, so
 * N hooks-declaring connectors fan out N reconciles that all read this map
 * before any of them writes.
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
  return serializePerWorkspace(wsId, async () => {
    const ws = await store.get(wsId);
    if (!ws) return null;
    const next = mutate({ ...(ws.hooks ?? {}) });
    if (next === null) return null;
    await store.update(wsId, { hooks: next });
    return next;
  });
}

/**
 * One write at a time per workspace.
 *
 * The critical section is the whole read-through-write, not the write alone:
 * `WorkspaceStore.update` re-reads the record and replaces `hooks` wholesale,
 * so two callers that both read an empty map each write a map containing only
 * their own entry, and the second erases the first. Holding the section across
 * the read is what makes a concurrent mutation see the previous one's result.
 *
 * In-process only, which is the same assumption `singleFlight` in `reconcile.ts`
 * already makes and is sufficient while a tenant runs one runtime pod — the
 * `replicas > 1` prerequisites in `AGENTS.md` are unmet, and clustering this
 * state belongs to that project rather than to a lock.
 *
 * It also closes the `rotate_hook`-vs-reconcile window that `ensureHooks`
 * leaves open by bypassing the flight for a rotation: the two can still run
 * concurrently, but they can no longer interleave inside the write.
 */
const writeChains = new Map<string, Promise<unknown>>();

function serializePerWorkspace<T>(wsId: string, task: () => Promise<T>): Promise<T> {
  const prior = writeChains.get(wsId) ?? Promise.resolve();
  // `then(task, task)` so a failed predecessor does not cancel the queue — one
  // caller's error must not strand every writer behind it.
  const next = prior.then(task, task);
  // The stored tail swallows settlement so a rejection here is never unhandled;
  // the real outcome reaches the caller through `next`.
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(wsId, tail);
  void tail.then(() => {
    // Drop the entry only when nobody queued behind us, so the map does not
    // grow one permanent promise per workspace for the life of the process.
    if (writeChains.get(wsId) === tail) writeChains.delete(wsId);
  });
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
