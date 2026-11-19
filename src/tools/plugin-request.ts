import { structuredContent, textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { PluginRequestOutput } from "../platform/schemas/plugins.ts";
import { getRequestContext } from "../runtime/request-context.ts";
import {
  listUngrantedPersonalPlugins,
  type ManageConnectorsContext,
  type UngrantedPersonalPlugin,
} from "./connector-tools.ts";

/**
 * How a model learns of, and asks for, the caller's own plugins that are not
 * turned on in the workspace its run is in (ADR-0069 "Only the owner grants").
 *
 * - **Knowing.** `nb__search` (`scope: "tools"`) lists them by name as the
 *   caller's, not turned on here. It lists no tool of theirs: nothing of an
 *   ungranted plugin is callable or promotable, so naming it costs nothing.
 * - **Asking.** `nb__manage_tools` `request_plugin` names one. It writes
 *   nothing and returns at once with a {@link PluginRequestOutput}; the web chat
 *   renders that as a card whose "Use here" calls the first-party
 *   `grant_connector`, the same write the Plugins page makes. The person's
 *   answer reaches the model as their next message.
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
  lines.push(
    'To use one, ask the person with nb__manage_tools `{"request_plugin": "<name>"}`, then end your turn: their answer arrives as their next message.',
  );
  return lines.join("\n");
}

function refuse(message: string): ToolResult {
  return { content: textContent(message), isError: true };
}

/**
 * `nb__manage_tools` `request_plugin`: ask the caller to turn on one of their
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
      "request_plugin asks the person in a conversation; this call has no conversation.",
    );
  }
  const scope = callerAndWorkspace(ctx);
  if (!scope) return refuse("request_plugin needs a signed-in person and a workspace.");

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
      `Asked the person whether to use ${plugin.displayName} in this workspace. Nothing is turned on yet. End your turn now: their answer arrives as their next message, and if they turn it on, its tools are reachable from then on.`,
    ),
    structuredContent: structuredContent(output),
    isError: false,
  };
}
