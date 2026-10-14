import { log } from "../observability/log.ts";
import {
  advertisesLifecycle,
  type LifecycleRejection,
  selectLifecycleHandlers,
} from "../services/lifecycle-extension.ts";
import type { Tool } from "../tools/types.ts";
import type { LifecycleBinding } from "./types.ts";

/**
 * The `ai.nimblebrain/lifecycle` binding of each workspace connector's
 * connection, held in memory.
 *
 * Held rather than re-read because the server's capability map lives on the
 * live client and is gone once the connection closes (an idle close, a crash),
 * while `on_removing` is called at uninstall, which may come long after. So the
 * binding is snapshotted when the connection reaches `running` and again
 * whenever its tool set changes (`notifications/tools/list_changed`, a
 * reconnect), and a connector with no snapshot, such as one never running in
 * this process, is discovered on demand: reconnecting first when asked to,
 * which is what the uninstall path asks. A new process rediscovers on its first
 * `running`.
 */

/** What the host knows of one connection's lifecycle extension. */
export type WireLifecycle =
  | { advertised: false }
  | { advertised: true; binding: LifecycleBinding; rejected: LifecycleRejection[] };

/** The slice of a live connector source the binding is read from. */
export interface LifecycleSourceLike {
  /** Whether the connection has completed its handshake. */
  connected(): boolean;
  /** Reconnect a dropped connection; whether one is up afterward. */
  reconnect(): Promise<boolean>;
  /** The extensions the server advertised on this connection. */
  serverExtensions(): Record<string, unknown>;
  /** The server's tools, named as the server names them (bare). */
  tools(): Promise<Tool[]>;
}

const snapshots = new Map<string, WireLifecycle>();
/** The rejections last reported per connector, so a refresh that finds the same ones stays quiet. */
const reported = new Map<string, string>();

function key(wsId: string, connector: string): string {
  return `${wsId}|${connector}`;
}

/**
 * Read the binding from the live connection and hold it. `undefined` when the
 * connection is not up: nothing is known, and nothing is held.
 *
 * An advertised extension with an empty tool list is returned with no handlers
 * and not held. The server has listed nothing yet, so the next tool-set change
 * snapshots again; holding it would read as "advertised, wants no events".
 */
export async function snapshotLifecycleBinding(
  wsId: string,
  connector: string,
  source: LifecycleSourceLike,
): Promise<WireLifecycle | undefined> {
  if (!source.connected()) return undefined;
  if (!advertisesLifecycle(source.serverExtensions())) {
    const wire: WireLifecycle = { advertised: false };
    snapshots.set(key(wsId, connector), wire);
    return wire;
  }
  const tools = await source.tools();
  const { binding, rejected } = selectLifecycleHandlers(tools);
  const wire: WireLifecycle = { advertised: true, binding, rejected };
  if (tools.length === 0) return wire;
  snapshots.set(key(wsId, connector), wire);
  reportRejections(wsId, connector, rejected);
  return wire;
}

/**
 * The held binding, or one discovered now. With `rediscover`, a connection that
 * is down is reconnected first, as the extension requires before the host
 * concludes `removing` is undeclared. Without it nothing reconnects, so a
 * listing never dials a server.
 */
export async function lifecycleBindingFor(
  wsId: string,
  connector: string,
  source: LifecycleSourceLike | undefined,
  opts: { rediscover?: boolean } = {},
): Promise<WireLifecycle | undefined> {
  const held = snapshots.get(key(wsId, connector));
  if (held || !source) return held;
  if (opts.rediscover && !source.connected()) await source.reconnect();
  return snapshotLifecycleBinding(wsId, connector, source);
}

/** Drop a connector's binding on uninstall: a reinstall discovers its own. */
export function forgetLifecycleBinding(wsId: string, connector: string): void {
  snapshots.delete(key(wsId, connector));
  reported.delete(key(wsId, connector));
}

/** Drop every binding. Called on runtime shutdown, beside `resetReadyNotifications`. */
export function resetLifecycleBindings(): void {
  snapshots.clear();
  reported.clear();
}

/**
 * Warn about marked tools the host will not call, once per distinct set per
 * connector. The install path also returns them as install warnings
 * ({@link lifecycleContractWarnings}).
 */
function reportRejections(wsId: string, connector: string, rejected: LifecycleRejection[]): void {
  const signature = rejected.map((r) => `${r.tool}:${r.reason}`).join("\n");
  if (reported.get(key(wsId, connector)) === signature) return;
  reported.set(key(wsId, connector), signature);
  for (const r of rejected) {
    log.warn("[lifecycle] marked tool is not a lifecycle handler", {
      connector,
      workspace_id: wsId,
      tool: r.tool.slice(0, 60),
      reason: r.reason,
    });
  }
}

/** The binding's rejections as install warnings, one sentence each. */
export function lifecycleContractWarnings(
  connector: string,
  wire: WireLifecycle | undefined,
): string[] {
  if (!wire?.advertised) return [];
  return wire.rejected.map(
    (r) =>
      `Connector "${connector}" marks "${r.tool.slice(0, 60)}" as a lifecycle handler, but ${r.reason}; the host does not call it.`,
  );
}
