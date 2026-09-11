import { log } from "../observability/log.ts";
import { type ConnectorPort, watchToolSurface } from "../tools/connector-surface.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { HookContractError, type ProvisionedHook, provisionHooks } from "./provisioning.ts";
import { findRegistration } from "./registrations.ts";
import type { HookIdentity } from "./token.ts";
import type { HookDeclaration } from "./types.ts";

/**
 * Keeping a workspace's hook registrations in step with what its connectors
 * declare.
 *
 * The invariant is one sentence: **for every installed connector that declares
 * a hook, there is a current registration and the server has been handed its
 * URL.** Expressing it as a reconcile rather than as a step inside the install
 * handler is what makes it hold on all three paths that can establish a
 * connection — a fresh install, a boot, and an interactive OAuth flow
 * completing minutes after the install returned — without the same logic
 * appearing in three places and drifting between them.
 *
 * It is a reconcile in shape, not a timer. It runs on the two events that make
 * both halves it needs true — a declaration to read, and a live source to call
 * `register_tool` on: a connection reaching `running`, and the connector's tool
 * set becoming enumerable (`watchToolSurface`, shared with the lifecycle
 * notification in `src/tools/connector-surface.ts`). Nothing here polls, and
 * nothing needs to: the minted URL is stable across restarts and the server
 * persists it, so the work is bounded by those transitions rather than by a
 * clock.
 */

export interface HookReconcileDeps {
  workspaceStore: WorkspaceStore;
  /**
   * The hook declarations for an installed connector, from OPERATOR-TRUSTED
   * metadata — the published catalog entry, never a caller-supplied one. A
   * forged entry that could inject a route would be choosing where this runtime
   * sends a delivery, with a freshly minted platform token attached.
   */
  declarationsFor(serverName: string): Promise<HookDeclaration[]>;
  /** The live source for `(wsId, serverName)`, or undefined when it is not running. */
  portFor(wsId: string, serverName: string): ConnectorPort | undefined;
  /** This runtime's hook identity, or undefined when it has no hooks door. */
  identity: HookIdentity | undefined;
}

export interface EnsureHooksOptions {
  /**
   * Skip streams that already hold an ADDRESSABLE registration entirely — no
   * re-mint and no `register_tool` call. A registration with no `deliveryId`
   * counts as missing: the door refuses it, so the stream is as dead as one
   * that was never provisioned.
   *
   * Set on the connection-reached-running path, where re-registering every
   * already-live stream on every boot and every self-heal would call the
   * server (and through it, often the vendor's API) for no change. An install
   * leaves it off: the operator asked for the install, so re-handing the URL is
   * the deliberate act that repairs a registration the server lost.
   */
  onlyMissing?: boolean;
  /** Mint a fresh key id, retiring the current one into the grace window. */
  rotate?: boolean;
  /** Restrict to one vendor. */
  onlyVendor?: string;
}

/**
 * Bring one connector's hooks in a workspace to their declared state.
 *
 * Silent no-op — not an error — when this runtime has no hooks door, when the
 * connector declares no hooks, or when its source is not running. All three are
 * ordinary states rather than failures, and a connector must install and work
 * normally in every one of them.
 *
 * A {@link HookContractError} propagates rather than being swallowed: a declared
 * `register_tool` that does not exist or does not accept `{vendor, url}` is a
 * manifest bug, and provisioning nothing is better than leaving a stream that
 * can never be handed its URL. The caller decides how loud that is — the
 * install path reports it as a warning on a successful install (it cannot
 * refuse an install that has already committed), and the connection-running
 * path logs it.
 */
export async function ensureHooks(
  deps: HookReconcileDeps,
  wsId: string,
  connector: string,
  opts: EnsureHooksOptions = {},
): Promise<ProvisionedHook[]> {
  const identity = deps.identity;
  if (!identity) return [];

  let declarations = await deps.declarationsFor(connector);
  if (declarations.length === 0) return [];

  if (opts.onlyMissing) {
    const ws = await deps.workspaceStore.get(wsId);
    if (!ws) return [];
    // MISSING MEANS UNADDRESSABLE, not merely unrecorded. A registration written
    // before the URL became an opaque id has a `kid` and no address, and the door
    // refuses it — so the stream is as dead as one that was never provisioned,
    // and a filter keyed on the record's existence skips it on every boot for
    // ever. That is why such a record survived: nothing was missing, so nothing
    // reconciled it, and the only thing that noticed was a vendor never
    // delivering.
    declarations = declarations.filter(
      (d) => !findRegistration(ws, connector, d.vendor)?.deliveryId,
    );
    if (declarations.length === 0) return [];
  }

  const port = deps.portFor(wsId, connector);
  if (!port) {
    // The source is not up yet — an interactive-OAuth connector at install
    // time, or a connector still starting. Nothing is recorded, so nothing is half
    // done; the same reconcile runs when the connection reaches `running`.
    log.debug("mcp", `[hooks] ${connector} declares hooks but is not running yet — deferring`);
    return [];
  }

  const run = () =>
    provisionHooks({
      store: deps.workspaceStore,
      wsId,
      connector,
      declarations,
      port,
      rotate: opts.rotate,
      onlyVendor: opts.onlyVendor,
    });

  // A rotation always mints, so it must never be deduped into somebody else's
  // in-flight ensure — an operator who asked for a fresh URL has to get one.
  if (opts.rotate) return run();
  return singleFlight(flightKey(wsId, connector), run);
}

/**
 * Coalesce concurrent provisioning for one `(workspace, connector)`.
 *
 * A fresh install reaches `provisionHooks` from TWO directions at once: the
 * connection-reached-running observer, fired from inside the awaited
 * `startConnectorSource`, and the install handler on the line after the eager
 * start returns. Both read the workspace before either writes, so both see no
 * registration and both mint — two divergent `kid`s, one persisted, neither
 * recorded as the other's `prevKid`, and `register_tool` called twice with two
 * different URLs. Because which URL the server keeps is independent of which
 * write landed, the connector can be left registered on a `kid` the door will
 * never admit: every delivery 404s, permanently and silently, while the
 * registration looks healthy.
 *
 * The flight is entered AFTER the `onlyMissing` filter and the not-running
 * return, deliberately. That is what keeps the two callers from coalescing on
 * divergent intent: on a fresh install their declaration sets are identical
 * because neither has a registration to filter, and where a registration
 * already has an address the observer's set is empty and it returns before the
 * flight, leaving the install to re-register alone. The one gap is a
 * registration with no address, which the observer counts as missing: beside
 * addressable streams on the same connector, the install can join the
 * observer's narrower pass and skip re-handing the live URLs that once. Nothing
 * writes an address-less record, so that population only shrinks.
 */
const flights = new Map<string, Promise<ProvisionedHook[]>>();

function flightKey(wsId: string, connector: string): string {
  return `${wsId}|${connector}`;
}

function singleFlight(
  key: string,
  run: () => Promise<ProvisionedHook[]>,
): Promise<ProvisionedHook[]> {
  const inflight = flights.get(key);
  if (inflight) return inflight;
  // Started before the map write so a synchronous throw inside `run` cannot
  // leave a rejected promise parked under the key.
  const started = run();
  flights.set(key, started);
  // Cleared whether it resolved or threw, so a failed provision does not pin
  // every later caller to the rejection.
  return started.finally(() => {
    if (flights.get(key) === started) flights.delete(key);
  });
}

/**
 * The connection-reached-running path: ensure only what is missing, never
 * throw, and leave a way back for the attempt that could not finish.
 *
 * A contract error here cannot fail an install (the install already returned),
 * so surfacing it as a rejected promise would only produce an unhandled one. It
 * is logged at warn with the connector named — the operator's signal that a
 * manifest is wrong — and the connector keeps working without that stream.
 *
 * The tool-surface watch is cheap to fire: `onlyMissing` filters a
 * fully-provisioned connector to an empty declaration set before anything
 * reaches the source, so the common case — a healthy connector reconnecting —
 * costs a workspace read and stops.
 */
export function ensureHooksOnRunning(
  deps: HookReconcileDeps,
  wsId: string,
  connector: string,
): void {
  watchToolSurface("hooks", wsId, connector, deps.portFor(wsId, connector), () =>
    retrigger(deps, wsId, connector),
  );
  provisionInBackground(deps, wsId, connector);
}

/** Run the reconcile for its effect, reporting a failure rather than raising it. */
function provisionInBackground(deps: HookReconcileDeps, wsId: string, connector: string): void {
  void ensureHooks(deps, wsId, connector, { onlyMissing: true }).catch((err) => {
    const contract = err instanceof HookContractError;
    log.warn("[hooks] could not provision declared hooks for a running connector", {
      connector,
      workspace_id: wsId,
      reason: err instanceof Error ? err.message : String(err),
      contract_error: contract,
    });
  });
}

/**
 * Keys with a follow-up pass already queued behind an in-flight one. A burst of
 * signals collapses to one follow-up: every one of them says the same thing.
 */
const queuedAfterFlight = new Set<string>();

/**
 * Run a pass for a tool-set change, which must never be answered by a pass that
 * has already read the tool list.
 *
 * `singleFlight` coalesces concurrent provisioning for a connector, and for the
 * two callers it was written for that is exactly right: an install and its
 * connection-running observer ask the same question at the same moment. A
 * tool-set change does not ask that question — its whole content is "the list
 * you read is stale" — so handing it the in-flight pass's answer consumes the
 * one notice that a re-read was needed, and a deferred stream stays deferred
 * with nothing left to fire.
 *
 * It must not skip the flight either: two passes minting concurrently is the
 * divergent-`kid` failure `singleFlight` exists to prevent. So it waits for the
 * stale pass and then runs its own, which can only read at or after the change.
 * A rejected flight is still a reason to run — a manifest that failed the
 * contract check may be precisely what changed.
 */
function retrigger(deps: HookReconcileDeps, wsId: string, connector: string): void {
  const key = flightKey(wsId, connector);
  const inflight = flights.get(key);
  if (!inflight) {
    provisionInBackground(deps, wsId, connector);
    return;
  }
  if (queuedAfterFlight.has(key)) return;
  queuedAfterFlight.add(key);
  // Chained on the flight's own promise, which `singleFlight` clears from
  // `flights` in a handler registered before this one — so the follow-up always
  // starts a fresh flight rather than rejoining the one it is waiting on.
  void inflight
    .catch(() => {})
    .then(() => {
      queuedAfterFlight.delete(key);
      provisionInBackground(deps, wsId, connector);
    });
}
