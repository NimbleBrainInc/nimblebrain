import { log } from "../observability/log.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import {
  type HookConnectorPort,
  HookContractError,
  type ProvisionedHook,
  provisionHooks,
} from "./provisioning.ts";
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
 * set becoming enumerable (`watchToolSurface`). Nothing here polls, and nothing
 * needs to: the minted URL is stable across restarts and the server persists
 * it, so the work is bounded by those transitions rather than by a clock.
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
  portFor(wsId: string, serverName: string): HookConnectorPort | undefined;
  /** This runtime's hook identity, or undefined when it has no hooks door. */
  identity: HookIdentity | undefined;
}

export interface EnsureHooksOptions {
  /**
   * Skip streams that already hold a registration entirely — no re-mint and no
   * `register_tool` call.
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
    declarations = declarations.filter((d) => !findRegistration(ws, connector, d.vendor));
    if (declarations.length === 0) return [];
  }

  const port = deps.portFor(wsId, connector);
  if (!port) {
    // The source is not up yet — an interactive-OAuth connector at install
    // time, or a bundle still starting. Nothing is recorded, so nothing is half
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
 * `startBundleSource`, and the install handler on the line after the eager
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
 * divergent intent: the only path where both have work to do is the fresh
 * install, where their declaration sets are identical because neither has a
 * registration to filter. On a reinstall the observer's set is already empty
 * and it returns before the flight, leaving the install to re-register alone.
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
 */
export function ensureHooksOnRunning(
  deps: HookReconcileDeps,
  wsId: string,
  connector: string,
): void {
  watchToolSurface(deps, wsId, connector);
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

/** The armed tool-set watches, one per (workspace, connector). */
const watches = new Map<string, () => void>();

/**
 * Re-run the reconcile whenever a connector's tool set changes.
 *
 * `running` is when a CONNECTION is established, which is not when its server
 * has advertised anything, and it is a one-shot: a source whose tools populate
 * after the transition has no second transition to be provisioned on, and a
 * source that reconnects — a health-monitor restart, a re-auth, a server
 * redeployed under the same URL — reconnects through the source alone and
 * records no connection state, so no second transition is observed even though
 * the connection is live again. Either way an attempt that could not finish had
 * nothing to try again, and the stream stayed unprovisioned until the runtime
 * process restarted.
 *
 * The source's own tool-set signal is the seam that covers both, and it is why
 * this needs no timer: it fires on connect, on every reconnect, and on a
 * server's native `tools/list_changed`. Its meaning — "my tools are enumerable
 * and may have changed" — is exactly the precondition provisioning was missing.
 *
 * Cheap to fire: `onlyMissing` filters a fully-provisioned connector to an empty
 * declaration set before anything reaches the source, so the common case (a
 * healthy connector reconnecting) costs a workspace read and stops.
 *
 * One watch per (workspace, connector), re-armed on each transition to `running`
 * so it always points at the source that is live NOW — a reinstall builds a new
 * source object, and a watch left on the old one would fire for a source nobody
 * routes to. {@link stopWatchingHooks} drops it on uninstall.
 */
function watchToolSurface(deps: HookReconcileDeps, wsId: string, connector: string): void {
  // Drop the previous watch BEFORE deciding whether a new one can be armed: a
  // re-arm that finds no live source is the one case where the old watch is
  // certainly pointing at a source on its way out.
  const key = flightKey(wsId, connector);
  watches.get(key)?.();
  watches.delete(key);
  const port = deps.portFor(wsId, connector);
  if (!port?.subscribeToolsChanged) return;
  watches.set(
    key,
    port.subscribeToolsChanged(() => retrigger(deps, wsId, connector)),
  );
}

/**
 * Drop a connector's tool-set watch. Called on uninstall, beside the
 * registration revoke: the connector has no declarations left to reconcile, and
 * the closure would otherwise hold its source past the point anything routes to
 * it.
 */
export function stopWatchingHooks(wsId: string, connector: string): void {
  const key = flightKey(wsId, connector);
  watches.get(key)?.();
  watches.delete(key);
}

/**
 * Drop every armed watch. Called on runtime shutdown, which removes the sources
 * but not the module-level map that holds them: each entry retains the
 * unsubscribe closure, its source, and through the listener's `deps` the runtime
 * that built them, so a process that starts more than one runtime keeps every
 * earlier one alive.
 */
export function stopAllHookWatches(): void {
  for (const unwatch of watches.values()) unwatch();
  watches.clear();
}
