/**
 * Workspace conversation starters: those of the plugins a workspace has
 * installed, which the overview offers a member who does not know what to ask.
 *
 * They are read from the workspace's installed-plugin records (ADR-0077),
 * which keep the starters each install's verified artifact carried. Nothing
 * opens an archive or reads a catalog. A connector no record names (one added
 * by URL, or a catalog install adoption left plain) has none.
 *
 * Each plugin's starters are joined to the first of its connections the
 * workspace has, by server name, which the overview uses for status and icon.
 * A plugin with no connection here (a skill-only plugin) offers none, since a
 * starter is shown against a connection.
 *
 * Best-effort: records that cannot be read give no starters rather than an
 * error, because starters are a suggestion and the overview stands without them.
 */

import { isUsableConnectorRef, serverNameFromRef } from "../connectors/runtime/paths.ts";
import type { ConnectorRef } from "../connectors/runtime/types.ts";
import { log } from "../observability/log.ts";
import type { ConversationStarter } from "../platform/schemas/home.ts";
import { connectionOf, type InstalledPluginRecord } from "../plugins/installed/record.ts";

export interface WorkspaceConversationStartersDeps {
  /** The workspace's installed connectors. */
  connectors: (wsId: string) => Promise<readonly ConnectorRef[]>;
  /** The workspace's installed-plugin records, in install order. */
  records: (wsId: string) => Promise<readonly InstalledPluginRecord[]>;
}

/** A plugin's name in its catalog: its address before `@`. */
function pluginName(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(0, at) : address;
}

export async function workspaceConversationStarters(
  wsId: string,
  deps: WorkspaceConversationStartersDeps,
): Promise<ConversationStarter[]> {
  try {
    const [refs, records] = await Promise.all([deps.connectors(wsId), deps.records(wsId)]);
    const present = new Set<string>();
    for (const ref of refs) {
      const serverName = serverNameFromRef(ref);
      if (serverName !== null && isUsableConnectorRef(ref)) present.add(serverName);
    }
    return records.flatMap((record) => {
      const serverName = record.connectors.map(connectionOf).find((name) => present.has(name));
      if (!serverName) return [];
      return record.starters.map((s) => ({
        serverName,
        plugin: pluginName(record.address),
        title: s.title,
        text: s.text,
      }));
    });
  } catch (err) {
    log.warn(
      `[conversation-starters] could not read them for ${wsId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
