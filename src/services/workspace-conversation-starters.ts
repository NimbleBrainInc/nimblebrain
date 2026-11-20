/**
 * Workspace conversation starters: those of the plugins a workspace has
 * installed, which the overview offers a member who does not know what to ask.
 *
 * Each installed connector is matched to the server its plugin names by
 * registry name (`registryNameFromCatalog`, the same lookup the skill reconcile
 * uses), and the plugin's conversation starters are read from the pinned
 * catalog (`resolveServerConversationStarters`). Nothing is stored: the catalog's archives are
 * cached by digest, so a read after the first is local.
 *
 * Best-effort: a catalog that cannot be read gives no starters rather than an
 * error, because starters are a suggestion and the overview stands without them.
 */

import type { ConnectorCatalogEntry } from "../connectors/catalog/types.ts";
import { registryNameFromCatalog } from "../connectors/runtime/connector-skill-reconcile.ts";
import { isUsableConnectorRef, serverNameFromRef } from "../connectors/runtime/paths.ts";
import type { ConnectorRef } from "../connectors/runtime/types.ts";
import { log } from "../observability/log.ts";
import type { ConversationStarter } from "../platform/schemas/home.ts";
import type { ServerConversationStarters } from "../skills/connector-skill-resolver.ts";

export interface WorkspaceConversationStartersDeps {
  /** The workspace's installed connectors. */
  connectors: (wsId: string) => Promise<readonly ConnectorRef[]>;
  catalogByIdMap: () => Promise<ReadonlyMap<string, ConnectorCatalogEntry>>;
  catalogByUrl: () => Promise<ReadonlyMap<string, ConnectorCatalogEntry>>;
  /** The starters of the plugins naming these registry names (`resolveServerConversationStarters`). */
  resolveConversationStarters: (
    servers: readonly string[],
  ) => Promise<ServerConversationStarters[]>;
}

export async function workspaceConversationStarters(
  wsId: string,
  deps: WorkspaceConversationStartersDeps,
): Promise<ConversationStarter[]> {
  try {
    const refs = await deps.connectors(wsId);
    // Registry name → this workspace's server name for it. A catalog lookup is
    // needed only for a connector whose skill lock records no registry name.
    const needsCatalog = refs.some((ref) => !ref.skillsLock?.[0]?.server);
    const [byId, byUrl] = needsCatalog
      ? await Promise.all([deps.catalogByIdMap(), deps.catalogByUrl()])
      : [undefined, undefined];
    const serverNameFor = new Map<string, string>();
    for (const ref of refs) {
      const serverName = serverNameFromRef(ref);
      if (serverName === null || !isUsableConnectorRef(ref)) continue;
      const registry = registryNameFromCatalog(ref, byId, byUrl);
      if (registry && !serverNameFor.has(registry)) serverNameFor.set(registry, serverName);
    }
    if (serverNameFor.size === 0) return [];

    const found = await deps.resolveConversationStarters([...serverNameFor.keys()]);
    return found.flatMap((entry) => {
      const serverName = serverNameFor.get(entry.server);
      if (!serverName) return [];
      return entry.conversationStarters.map((s) => ({
        serverName,
        plugin: entry.plugin,
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
