import { timingSafeEqual } from "node:crypto";
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

/**
 * Whether a presented delivery id is admissible for a registration, now.
 *
 * Exactly two are: the current id, and the immediately-previous one while its
 * grace window is open. Anything else — an id from two rotations ago, one
 * belonging to another workspace, one invented — takes the identical rejection
 * path, so a prober learns nothing from the difference between "retired" and
 * "never existed".
 *
 * This replaced a twin that weighed the KEY id. The key and the id rotate
 * together, so keeping both would have been two windows to hold in step, and a
 * disagreement between them would decide whether a delivery lands.
 *
 * Compared in constant time. The id is 256 bits of uniform randomness behind a
 * per-source rate limit, so a timing oracle is not a practical attack — but the
 * comparison is the only thing standing between a guess and a forward, and
 * making it constant-time costs three lines and ends the question rather than
 * leaving a reviewer to re-derive that argument.
 */
export function isDeliveryIdAdmissible(
  reg: HookRegistration,
  deliveryId: string,
  now: number = Date.now(),
): boolean {
  // A registration written before delivery ids existed carries no id to compare
  // against. It is inadmissible, and deliberately not an error: the door scans
  // every workspace, so throwing here would let one stale record answer 500 for
  // deliveries belonging to workspaces that are perfectly current — and a 500 is
  // the one distinguishable answer this door exists to never give. Rotating the
  // stream writes an id and repairs it.
  if (reg.deliveryId && equalsConstantTime(deliveryId, reg.deliveryId)) return true;
  const prev = reg.prevDeliveryId;
  if (!prev || !isPreviousStillValid(reg, now)) return false;
  return equalsConstantTime(deliveryId, prev);
}

/**
 * Whether a rotated stream's PREVIOUS URL is still one the door will admit.
 *
 * Exported because the operator surface has to report the same window the door
 * enforces. Two copies of this rule is how a settings page comes to promise an
 * admin that the old URL still works for a day after the door stopped taking it.
 */
export function isPreviousStillValid(
  reg: Pick<HookRegistration, "prevDeliveryId" | "rotatedAt">,
  now: number = Date.now(),
): boolean {
  if (!reg.prevDeliveryId || !reg.rotatedAt) return false;
  const rotatedAt = Date.parse(reg.rotatedAt);
  if (!Number.isFinite(rotatedAt)) return false;
  return now - rotatedAt < HOOK_ROTATION_GRACE_MS;
}

/**
 * Constant-time string equality. A length mismatch returns early, which leaks
 * only the length — not a secret, and `timingSafeEqual` requires equal lengths
 * anyway.
 */
function equalsConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Every registration on a workspace record, as a stable-ordered list. */
export function listRegistrations(ws: Pick<Workspace, "hooks">): HookRegistration[] {
  return Object.values(ws.hooks ?? {}).sort((a, b) =>
    keyOf(a.connector, a.vendor).localeCompare(keyOf(b.connector, b.vendor)),
  );
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
    deliveryId: string;
    route: string;
    headerRenames?: Record<string, string>;
  },
  nowIso: string = new Date().toISOString(),
): HookRegistration {
  const reg: HookRegistration = {
    connector: next.connector,
    vendor: next.vendor,
    kid: next.kid,
    deliveryId: next.deliveryId,
    createdAt: existing?.createdAt ?? nowIso,
    route: next.route,
  };
  if (next.headerRenames && Object.keys(next.headerRenames).length > 0) {
    reg.headerRenames = next.headerRenames;
  }
  if (existing) {
    reg.prevKid = existing.kid;
    // The id rotates WITH the key, so its grace window is the same window. A
    // vendor's in-flight redeliveries were queued against the outgoing URL, and
    // that URL carries the outgoing id — honouring one without the other would
    // drop exactly the deliveries the grace exists for.
    reg.prevDeliveryId = existing.deliveryId;
    reg.rotatedAt = nowIso;
  }
  return reg;
}

/** Registration map key, exported so callers building a map agree on it. */
export const registrationKey = keyOf;
