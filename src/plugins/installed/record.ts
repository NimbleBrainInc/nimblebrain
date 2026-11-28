/**
 * The installed-plugin record (ADR-0077): one per install per owner, saying
 * exactly what the install produced. Uninstall removes what it lists, update
 * replaces it, and nothing finds a plugin's parts again by opening an archive.
 *
 * It is stored beside the owner's connectors, under the same persistence:
 * `workspace.json#plugins` for a workspace (`WorkspaceStore`), and
 * `users/<id>/connectors.json#plugins` for a person (`IdentityConnectorStore`).
 * Both are read-modify-write with an atomic rename, and both keep install
 * order, which decides whose server record a shared connection reads.
 */

import type { CatalogOwner } from "../../connectors/catalog/binding.ts";
import type { ServerDetail } from "../../connectors/catalog/server-detail.ts";
import { slugifyServerName } from "../../connectors/runtime/paths.ts";
import { IdentityConnectorStore } from "../../identity/connector-store.ts";
import type { WorkspaceStore } from "../../workspace/workspace-store.ts";
import type { ConversationStarter } from "../extension.ts";

/** Who a plugin is installed for (ADR-0069): a workspace, or one person. */
export type PluginOwner = CatalogOwner;

/** Whether two owners are the same workspace or the same person. */
export function sameOwner(a: PluginOwner, b: PluginOwner): boolean {
  if (a.kind === "workspace") return b.kind === "workspace" && a.wsId === b.wsId;
  return b.kind === "person" && a.userId === b.userId;
}

/** One server a plugin names, and the connection it uses. */
export interface InstalledPluginConnector {
  /** The server's key in the plugin. */
  key: string;
  /** Its registry name (`com.notion/mcp`): the connection is `slugifyServerName(name)`. */
  name: string;
  /**
   * The server's record as the verified artifact carried it. A connection two
   * plugins name reads the record of the first of them in install order.
   */
  server: ServerDetail;
}

/** One managed skill a plugin produced. */
export interface InstalledPluginSkill {
  /** The name it was materialized under: its `SKILL.md` name, which is its folder's. */
  name: string;
  /** The server key it binds to, when it names one: it is then that connection's skill. */
  server?: string;
  /** sha256 (hex) of the `SKILL.md` it was materialized from. */
  sha: string;
}

export interface InstalledPluginRecord {
  /** `name@catalog`, the address it was installed by. */
  address: string;
  /** The digest of the artifact fetched (`sha256:<hex>`): what this install is pinned to. */
  digest: string;
  /** The listing entry's type: a plugin, or a bare connector or skill packaged as one. */
  type: string;
  installedAt: string;
  /** When an update last replaced what it owns. */
  updatedAt?: string;
  connectors: InstalledPluginConnector[];
  skills: InstalledPluginSkill[];
  /** What a host offers someone who has the plugin and does not know what to ask. */
  starters: ConversationStarter[];
}

/** A connector's lifecycle key, from its registry name. */
export function connectionOf(connector: Pick<InstalledPluginConnector, "name">): string {
  return slugifyServerName(connector.name);
}

/** The records of one owner, read and written beside that owner's connectors. */
export interface PluginRecordStore {
  list(owner: PluginOwner): Promise<InstalledPluginRecord[]>;
  get(owner: PluginOwner, address: string): Promise<InstalledPluginRecord | null>;
  /** Replace the record of the same address in place, else append it. */
  put(owner: PluginOwner, record: InstalledPluginRecord): Promise<void>;
  remove(owner: PluginOwner, address: string): Promise<boolean>;
}

export function createPluginRecordStore(deps: {
  workspaces: WorkspaceStore;
  workDir: string;
}): PluginRecordStore {
  const identity = new IdentityConnectorStore({ workDir: deps.workDir });

  const list = async (owner: PluginOwner): Promise<InstalledPluginRecord[]> => {
    if (owner.kind === "person") return identity.listPlugins(owner.userId);
    return (await deps.workspaces.get(owner.wsId))?.plugins ?? [];
  };

  return {
    list,
    get: async (owner, address) => (await list(owner)).find((r) => r.address === address) ?? null,
    put: async (owner, record) => {
      if (owner.kind === "person") {
        await identity.putPlugin(owner.userId, record);
      } else {
        const ws = await deps.workspaces.get(owner.wsId);
        if (!ws) throw new Error(`Workspace "${owner.wsId}" not found.`);
        const plugins = [...(ws.plugins ?? [])];
        const i = plugins.findIndex((p) => p.address === record.address);
        if (i >= 0) plugins[i] = record;
        else plugins.push(record);
        await deps.workspaces.update(owner.wsId, { plugins });
      }
    },
    remove: async (owner, address) => {
      let removed: boolean;
      if (owner.kind === "person") {
        removed = await identity.removePlugin(owner.userId, address);
      } else {
        const ws = await deps.workspaces.get(owner.wsId);
        const plugins = ws?.plugins ?? [];
        const next = plugins.filter((p) => p.address !== address);
        removed = next.length !== plugins.length;
        if (removed) await deps.workspaces.update(owner.wsId, { plugins: next });
      }
      return removed;
    },
  };
}
