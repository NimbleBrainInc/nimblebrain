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
 * It is a reconcile in shape, not a timer: it runs when a connection reaches
 * `running`, because that is the moment both halves it needs become true (a
 * declaration to read, and a live source to call `register_tool` on). Nothing
 * here polls, and nothing needs to: the minted URL is stable across restarts,
 * and the server persists it, so a runtime that comes back up has nothing to
 * repair.
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
 * A {@link HookContractError} propagates: a declared `register_tool` that does
 * not exist or does not accept `{vendor, url}` is a manifest bug, and the
 * install that surfaces it should fail loudly rather than leave a stream that
 * can never be handed its URL.
 */
export async function ensureHooks(
  deps: HookReconcileDeps,
  wsId: string,
  connector: string,
  opts: EnsureHooksOptions = {},
): Promise<ProvisionedHook[]> {
  if (!deps.identity) return [];

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

  return provisionHooks({
    identity: deps.identity,
    store: deps.workspaceStore,
    wsId,
    connector,
    declarations,
    port,
    rotate: opts.rotate,
    onlyVendor: opts.onlyVendor,
  });
}

/**
 * The connection-reached-running path: ensure only what is missing, and never
 * throw.
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
