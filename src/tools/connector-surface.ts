import { splitInnerToolName } from "../util/tool-name.ts";
import type { Tool, ToolResult, ToolSource } from "./types.ts";

/**
 * The slice of a live connector's source that a per-connector reconcile talks
 * to, and the signal that it changed.
 *
 * Two reconciles need exactly this much of a source and nothing else: the hooks
 * provisioning in `src/hooks/`, which hands a minted URL to a declared
 * registration tool, and the lifecycle notification in `src/lifecycle/`, which
 * tells a bundle it is installed or being removed. They ask different questions
 * of the connector and coalesce differently, so neither calls the other — what
 * they share is the port that reaches a source and the subscription that says
 * its tool list may have moved, and both live here rather than in whichever of
 * them happened to be written first.
 */

/**
 * The narrow slice of a connector's source a reconcile needs.
 *
 * **Both halves speak the BARE tool name** — the same vocabulary a manifest
 * declaration is written in. A registry source does not: it advertises
 * `<source>__<tool>` and takes the bare name on `execute`, because the
 * qualified form is what routes a call to the right source in a workspace-wide
 * tool list. A reconcile is already inside one source and has no such question
 * to answer, so the port answers in one vocabulary and
 * {@link connectorPortForSource} is the single place the two meet.
 */
export interface ConnectorPort {
  /** Advertised tools, named as a declaration names them. For the contract check. */
  tools(): Promise<Tool[]>;
  /** Invoke a tool by its bare name, through the ordinary MCP dispatch path. */
  execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult>;
  /**
   * Subscribe to "this source's tool set may have changed", returning an
   * unsubscribe. The reconciles' retrigger; see {@link watchToolSurface}.
   *
   * Optional because the underlying `ToolSource` method is: a source whose
   * tools are fixed at construction never fires one, and a port without it
   * simply has no retrigger.
   */
  subscribeToolsChanged?(listener: () => void): () => void;
}

/** The `tools()`/`execute()`/`subscribeToolsChanged()` slice of a registry source. */
type ConnectorSourceLike = Pick<ToolSource, "tools" | "execute" | "subscribeToolsChanged">;

/**
 * Adapt a registry source to the port, translating its advertised
 * `<source>__<tool>` names down to the bare names a declaration uses.
 *
 * Without the translation every declared tool name is absent from every tool
 * list, so a correct manifest is reported as a contract violation and nothing
 * is ever provisioned or notified. The two names are decomposed by
 * `splitInnerToolName`, the one grammar every door shares — a hand-rolled
 * `slice` here would be a second one.
 */
export function connectorPortForSource(source: ConnectorSourceLike): ConnectorPort {
  return {
    tools: async () =>
      (await source.tools()).map((t) => ({ ...t, name: splitInnerToolName(t.name).bareToolName })),
    execute: (toolName, input) => source.execute(toolName, input),
    subscribeToolsChanged: source.subscribeToolsChanged?.bind(source),
  };
}

/**
 * The advertised names, for a contract error that has to be actionable.
 *
 * A message that only names what is MISSING sends the reader to re-read a
 * manifest; naming what the server actually serves lets them see the mismatch —
 * a rename, a tool behind a flag the deployment does not set.
 *
 * Bounded on BOTH axes, because both are the server's to choose: a hundred tools
 * named at a hundred characters each is the same unbounded log line as a
 * thousand tools, and the names come off the wire.
 */
export function summarizeToolNames(tools: Tool[]): string {
  const shown = tools.slice(0, 12).map((t) => t.name.slice(0, 60));
  const joined = shown.join(", ");
  return tools.length > shown.length ? `${joined}, …` : joined;
}

/** First line of a tool error result, for a log field. Bounded so a verbose
 *  server cannot write an unbounded log line. */
export function summarizeToolError(result: ToolResult): string {
  const text = result.content?.find((c) => c.type === "text")?.text;
  return (text ?? "tool returned an error").split("\n")[0]?.slice(0, 200) ?? "tool error";
}

/** The armed tool-set watches, one per (purpose, workspace, connector). */
const watches = new Map<string, () => void>();

function watchKey(purpose: string, wsId: string, connector: string): string {
  return `${purpose}|${wsId}|${connector}`;
}

/**
 * Re-run a reconcile whenever a connector's tool set changes.
 *
 * `running` is when a CONNECTION is established, which is not when its server
 * has advertised anything, and it is a one-shot: a source whose tools populate
 * after the transition has no second transition to be reconciled on, and a
 * source that reconnects — a health-monitor restart, a re-auth, a server
 * redeployed under the same URL — reconnects through the source alone and
 * records no connection state, so no second transition is observed even though
 * the connection is live again. Either way an attempt that could not finish had
 * nothing to try again, and the work stayed undone until the runtime restarted.
 *
 * The source's own tool-set signal is the seam that covers both, and it is why
 * this needs no timer: it fires on connect, on every reconnect, and on a
 * server's native `tools/list_changed`. Its meaning — "my tools are enumerable
 * and may have changed" — is exactly the precondition both reconciles were
 * missing.
 *
 * One watch per (`purpose`, workspace, connector), re-armed on each transition
 * to `running` so it always points at the source that is live NOW — a reinstall
 * builds a new source object, and a watch left on the old one would fire for a
 * source nobody routes to. {@link stopWatchingToolSurface} drops every purpose
 * for a connector on uninstall.
 *
 * `purpose` namespaces the entry so two reconciles arming on the same
 * transition do not evict each other. Each subscribes to the same source
 * independently, which is what keeps the retrigger policy — coalescing, dedupe,
 * back-off — the property of the reconcile that owns it rather than of the
 * watch they share.
 */
export function watchToolSurface(
  purpose: string,
  wsId: string,
  connector: string,
  port: ConnectorPort | undefined,
  onChange: () => void,
): void {
  // Drop the previous watch BEFORE deciding whether a new one can be armed: a
  // re-arm that finds no live source is the one case where the old watch is
  // certainly pointing at a source on its way out.
  const key = watchKey(purpose, wsId, connector);
  watches.get(key)?.();
  watches.delete(key);
  if (!port?.subscribeToolsChanged) return;
  watches.set(key, port.subscribeToolsChanged(onChange));
}

/**
 * Drop every watch a connector holds in one workspace, across purposes. Called
 * on uninstall: the connector has nothing left to reconcile, and the closures
 * would otherwise hold its source past the point anything routes to it.
 */
export function stopWatchingToolSurface(wsId: string, connector: string): void {
  const suffix = `|${wsId}|${connector}`;
  for (const [key, unwatch] of [...watches]) {
    if (!key.endsWith(suffix)) continue;
    unwatch();
    watches.delete(key);
  }
}

/**
 * Drop every armed watch. Called on runtime shutdown, which removes the sources
 * but not the module-level map that holds them: each entry retains the
 * unsubscribe closure, its source, and through the listener's captured deps the
 * runtime that built them, so a process that starts more than one runtime keeps
 * every earlier one alive.
 */
export function stopAllToolSurfaceWatches(): void {
  for (const unwatch of watches.values()) unwatch();
  watches.clear();
}
