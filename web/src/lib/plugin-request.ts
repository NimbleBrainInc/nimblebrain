import type { Plugin } from "../_generated/platform-schemas/plugins";
import type { ToolCallDisplay } from "../hooks/chat-store";

/**
 * What a personal plugin turned on in a workspace means for its owner and the
 * other members. The same sentence the Plugins page's "Use here" confirmation
 * shows, so the answer reads the same wherever the person gives it.
 */
export const USE_HERE_NOTE =
  "Only you can use it here; other members can't. What your agent does with it is saved in this workspace, private to you unless you share it.";

/**
 * The plugin a finished call asked the person to turn on, when it is one
 * (`nb__manage_tools` with `request_plugin`). Read from the call's input, which
 * history keeps; the facts shown come from the caller's own plugin listing,
 * never from the call. Null for every other call.
 */
export function requestedPluginName(call: ToolCallDisplay): string | null {
  return call.status === "done" ? requestPluginArg(call) : null;
}

/**
 * The plugin a call asks for, finished or not: the `request_plugin` of an
 * `nb__manage_tools` call, or null for any other call.
 */
export function requestPluginArg(call: {
  name: string;
  input?: Record<string, unknown>;
}): string | null {
  if (call.name !== "nb__manage_tools") return null;
  const name = call.input?.request_plugin;
  return typeof name === "string" && name ? name : null;
}

/**
 * The caller's own plugin `serverName` in the chat workspace's listing, or
 * undefined. The listing holds only the caller's personal plugins, so a name
 * that is not theirs finds nothing.
 */
export function personalPluginNamed(
  plugins: readonly Plugin[],
  serverName: string,
): Plugin | undefined {
  return plugins.find(
    (p) => p.owner.kind === "person" && p.servers.some((s) => s.serverName === serverName),
  );
}

/** The account a plugin acts as, when its sign-in recorded one. */
export function pluginAccountLabel(plugin: Plugin): string | undefined {
  for (const server of plugin.servers) {
    const account = server.account?.email ?? server.account?.name;
    if (account) return account;
  }
  return undefined;
}

/** The person's answer, sent as their next message so the agent reads it. */
export function answerMessage(displayName: string, answer: "use" | "not_now"): string {
  return answer === "use"
    ? `I turned on ${displayName} in this workspace. Go ahead.`
    : `Not now: don't use ${displayName} in this workspace.`;
}
