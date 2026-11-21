import { structuredContent, textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import { type PluginRequestOutput, RequestPluginInput } from "../platform/schemas/plugins.ts";
import { getRequestContext } from "../runtime/request-context.ts";
import { splitInnerToolName } from "../util/tool-name.ts";
import {
  listUngrantedPersonalPlugins,
  type ManageConnectorsContext,
  type UngrantedPersonalPlugin,
} from "./connector-tools.ts";
import { isPersonalConnectorName, personalConnectorServerName } from "./identity-sources.ts";
import { type InProcessTool, typedTool } from "./in-process-app.ts";

/**
 * How a model learns of, and asks for, the caller's own plugins that are not
 * turned on in the workspace its run is in (ADR-0069 "Only the owner grants").
 *
 * - **Knowing.** `nb__search` (`scope: "tools"`) lists them by name as the
 *   caller's, not turned on here. It lists no tool of theirs: nothing of an
 *   ungranted plugin is callable or promotable, so naming it costs nothing.
 * - **Asking.** `nb__request_plugin` names one. It writes
 *   nothing and returns at once with a {@link PluginRequestOutput}; the web chat
 *   renders that as a card whose "Use here" calls the first-party
 *   `grant_connector`, the same write the Plugins page makes. The person's
 *   answer reaches the model as their next message.
 * - **Missing.** A model that names a tool of such a plugin anyway (one it saw
 *   before the plugin was turned off) gets {@link ungrantedPluginGuidance} in
 *   place of the generic not-found answer, from `nb__manage_tools` `add` and
 *   from a direct call, so it reaches `nb__request_plugin` without a search.
 *
 * The ask is its own kernel-direct tool rather than a field of
 * `nb__manage_tools`. Promotion edits the native engine's active tool set, so
 * an external agent runtime's tool projection holds `nb__manage_tools` back
 * (`src/execution/tool-projection.ts`); a request touches no engine state, so
 * it reaches every runtime. It is direct because the model asks in the same
 * message that reads the search result: proxied, it would cost a promote and a
 * round trip before the question reaches the person.
 *
 * Only the caller's own identity plane is read, so another member's plugins are
 * never named, and a run with no person in it (a task) never asks.
 */

/** The caller and workspace a discovery or request is for, or null when either is missing. */
function callerAndWorkspace(ctx: ManageConnectorsContext): {
  callerId: string;
  wsId: string;
} | null {
  const callerId = ctx.getIdentity()?.id;
  const wsId = ctx.getWorkspaceId();
  return callerId && wsId ? { callerId, wsId } : null;
}

/**
 * The caller's plugins not turned on here, for `nb__search`. Empty in an
 * unattended run, which has no one to ask, and wherever the caller or the
 * workspace is unknown. Never throws: discovery is an aside to a tool search.
 */
export async function discoverUngrantedPlugins(
  ctx: ManageConnectorsContext,
  query: string,
): Promise<UngrantedPersonalPlugin[]> {
  if (getRequestContext()?.unattended) return [];
  const scope = callerAndWorkspace(ctx);
  if (!scope) return [];
  try {
    const plugins = await listUngrantedPersonalPlugins(ctx, scope.callerId, scope.wsId);
    return matchPlugins(plugins, query);
  } catch {
    return [];
  }
}

/** Every plugin for an empty query; else those whose name or description holds a query term. */
function matchPlugins(
  plugins: readonly UngrantedPersonalPlugin[],
  query: string,
): UngrantedPersonalPlugin[] {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (terms.length === 0) return [...plugins];
  return plugins.filter((p) => {
    const text = `${p.serverName} ${p.displayName} ${p.description ?? ""}`.toLowerCase();
    return terms.some((t) => text.includes(t));
  });
}

/** The `nb__search` section naming the caller's plugins not turned on here. */
export function describeUngrantedPlugins(plugins: readonly UngrantedPersonalPlugin[]): string {
  const lines = [
    "Yours, not turned on in this workspace (no tools until the person turns one on):",
  ];
  for (const p of plugins) {
    const desc = (p.description ?? "").split("\n")[0]?.trim() ?? "";
    lines.push(
      `- **${p.serverName}** (${p.displayName})${desc ? `: ${desc.length > 100 ? `${desc.slice(0, 100)}…` : desc}` : ""}`,
    );
  }
  lines.push(askFor(plugins.map((p) => p.serverName)));
  return lines.join("\n");
}

/**
 * How to ask for the named plugins, with each exact name filled in. It says to
 * call the tool, not to tell the person to, and rules out the Plugins page:
 * the core prompt sends the person there for plugins they do not have, and
 * without that a model reads "ask the person" as an instruction to them.
 */
function askFor(serverNames: readonly string[]): string {
  const [only] = serverNames;
  const call =
    serverNames.length === 1 && only !== undefined
      ? `To use it, call nb__request_plugin with \`{"plugin": "${only}"}\` yourself`
      : `To use one, call nb__request_plugin yourself with its exact name: ${serverNames.map((n) => `\`{"plugin": "${n}"}\``).join(" or ")}`;
  return `${call}. That shows the person a one-click **Use here**. ${serverNames.length === 1 ? "It is" : "These are"} already theirs, so do not send them to the Plugins page. Then end your turn: their answer arrives as their next message.`;
}

/**
 * What to tell a model that named a tool of one of the caller's own plugins
 * that is off in this workspace, or null for any other name: another member's
 * plugin, one granted here, or no plugin at all keeps its generic answer. Only
 * a `my_` name is looked up, and only in the caller's own identity plane.
 * `scope` defaults to the caller and workspace of the call in flight.
 */
export async function ungrantedPluginGuidance(
  ctx: ManageConnectorsContext,
  toolName: string,
  scope: { callerId: string; wsId: string } | null = callerAndWorkspace(ctx),
): Promise<string | null> {
  const { sourcePrefix } = splitInnerToolName(toolName);
  if (!scope || !isPersonalConnectorName(sourcePrefix)) return null;
  const serverName = personalConnectorServerName(sourcePrefix);
  let plugin: UngrantedPersonalPlugin | undefined;
  try {
    const plugins = await listUngrantedPersonalPlugins(ctx, scope.callerId, scope.wsId);
    plugin = plugins.find((p) => p.serverName === serverName);
  } catch {
    return null;
  }
  if (!plugin) return null;
  const off = `${plugin.displayName} is your plugin but isn't turned on in this workspace.`;
  if (getRequestContext()?.unattended) {
    return `${off} A task cannot ask for it: a person must turn it on from Plugins.`;
  }
  return `${off} ${askFor([plugin.serverName])}`;
}

function refuse(message: string): ToolResult {
  return { content: textContent(message), isError: true };
}

/**
 * `nb__request_plugin`: ask the caller to turn on one of their
 * own plugins in this workspace. Writes nothing. Refused in an unattended run
 * and outside a conversation, where no person would see the request.
 */
export async function requestPlugin(
  ctx: ManageConnectorsContext,
  serverName: string,
): Promise<ToolResult> {
  const reqCtx = getRequestContext();
  if (reqCtx?.unattended) {
    return refuse(
      "A task runs with no one to ask, so it cannot request a plugin. The task's owner can turn the plugin on in this workspace's Plugins page.",
    );
  }
  if (!reqCtx?.conversationId) {
    return refuse(
      "nb__request_plugin asks the person in a conversation; this call has no conversation.",
    );
  }
  const scope = callerAndWorkspace(ctx);
  if (!scope) return refuse("nb__request_plugin needs a signed-in person and a workspace.");

  const plugins = await listUngrantedPersonalPlugins(ctx, scope.callerId, scope.wsId, {
    accountFor: serverName,
  });
  const plugin = plugins.find((p) => p.serverName === serverName);
  if (!plugin) {
    // Granted already, or not the caller's: the answer names only their own.
    return refuse(
      `"${serverName}" is not one of your plugins that is off in this workspace. nb__search lists the ones you can ask for.`,
    );
  }
  const workspace = await ctx.runtime.getWorkspaceStore().get(scope.wsId);
  const output: PluginRequestOutput = {
    pluginRequest: {
      serverName: plugin.serverName,
      displayName: plugin.displayName,
      account: plugin.account,
      wsId: scope.wsId,
      workspaceName: workspace?.name ?? scope.wsId,
    },
  };
  return {
    content: textContent(
      `The person now sees a card asking whether to use ${plugin.displayName} in this workspace, with **Use here** and **Not now**. Nothing is turned on yet. End your turn now and do not ask them yourself: the card is the question, so write at most one short line, or nothing. Their answer arrives as their next message, and if they turn it on, its tools are reachable from then on.`,
    ),
    structuredContent: structuredContent(output),
    isError: false,
  };
}

/** The `nb__request_plugin` tool, asking for the caller's plugins through `ctx`. */
export function createRequestPluginToolDef(ctx: ManageConnectorsContext): InProcessTool {
  return typedTool({
    name: "request_plugin",
    description:
      "Ask the person to turn on one of their own plugins in this workspace. Call it whenever nb__search lists one of their plugins as not turned on here and the task needs it, instead of sending them to the Plugins page: it shows them a one-click **Use here** in the chat. It turns nothing on, so end your turn after it: their answer arrives as their next message.",
    inputSchema: RequestPluginInput,
    handler: (input) => requestPlugin(ctx, input.plugin),
  });
}
