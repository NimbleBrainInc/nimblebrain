import type { ConnectedAccountIdentity } from "../connectors/providers/managed-provider.ts";
import type { PlacementDeclaration, PlacementEntry } from "../connectors/runtime/types.ts";
import type {
  Plugin,
  PluginAccount,
  PluginApp,
  PluginServerStatus,
  PluginSkill,
  PluginsListOutput,
} from "../platform/schemas/plugins.ts";
import { connectionOf, type InstalledPluginRecord } from "../plugins/installed/record.ts";

/**
 * The plugin listing (`manage_connectors` `list_plugins`), read from the
 * installed-plugin records (ADR-0077): each record of the workspace is a
 * workspace plugin with the connections it lists, and each record of the
 * caller's is a person's plugin, granted here or not (ADR-0069). A connector
 * no record names (one added by URL, or a catalog install adoption left plain)
 * is listed as a plugin of its own, with one server. Nothing opens an archive.
 *
 * Pure: the handler reads the facts through the code paths the other actions
 * use (`list_installed`, `list_personal_connectors`, `list_bound_skills`, the
 * placement registry) and this shapes them.
 */

/** What the listing needs of one connector, from `list_installed` or `list_personal_connectors`. */
export interface ConnectorFacts {
  serverName: string;
  displayName: string;
  /** What the connector does: its catalog entry's description. */
  description?: string | null;
  iconUrl?: string;
  status: PluginServerStatus;
  statusReason?: string;
  /** The account the connection is signed in as, when its sign-in recorded one. */
  identity?: ConnectedAccountIdentity;
}

/** A personal connector, with the workspaces its owner granted it to. */
export interface PersonalConnectorFacts extends ConnectorFacts {
  grantedWorkspaces: readonly string[];
  /**
   * The views its server places (the catalog's host block for it, else the
   * one its install stored), sanitized. Not registered in any workspace's
   * placements: a personal connector is never composed into a workspace.
   */
  placements?: readonly PlacementDeclaration[];
}

/** A skill bound to a workspace connector, as `list_bound_skills` reports it. */
export interface BoundSkillFacts {
  server: string;
  name: string;
  description?: string;
}

/** How a listing entry shows an installed plugin, by its address, when its catalog still lists it. */
export interface PluginDisplay {
  displayName: string;
  description?: string;
  iconUrl?: string;
}

export interface PluginListingFacts {
  wsId: string;
  workspace: readonly ConnectorFacts[];
  personal: readonly PersonalConnectorFacts[];
  /** The workspace's installed-plugin records, in install order. */
  workspaceRecords?: readonly InstalledPluginRecord[];
  /** The caller's installed-plugin records, in install order. */
  personalRecords?: readonly InstalledPluginRecord[];
  /** Display fields by plugin address, from the catalogs' listings. */
  displays?: ReadonlyMap<string, PluginDisplay>;
  /** The addresses of installed plugins their catalog no longer offers. */
  notOffered?: ReadonlySet<string>;
  overlays: readonly BoundSkillFacts[];
  published: readonly BoundSkillFacts[];
  /** The workspace's placements (`PlacementRegistry.forWorkspace`). */
  placements: readonly PlacementEntry[];
}

export function projectPlugins(facts: PluginListingFacts): PluginsListOutput {
  const workspace = grouped(facts.workspace, facts.workspaceRecords ?? [], facts.displays);
  const workspacePlugins = workspace.map(
    (g): Plugin => ({
      id: g.address ? `workspace:plugin:${g.address}` : `workspace:${g.connectors[0]?.serverName}`,
      ...g.display,
      ...recordFlags(g, facts.notOffered),
      owner: { kind: "workspace" },
      granted: true,
      servers: g.connectors.map(serverOf),
      skills: g.connectors.flatMap((c) => skillsOf(c.serverName, facts)),
      apps: g.connectors.flatMap((c) => appsOf(c, facts)),
    }),
  );
  // A personal connector's skills and views are not composed into the
  // workspace: overlays, published skills and placements are keyed by the
  // workspace's own connectors, whose server name a personal one may share. Its
  // apps come from its own placements, and only where it is granted, since a
  // view of a plugin that does not act here cannot render here. A person's
  // plugin acts here when every connection it has here is granted.
  const personal = grouped(facts.personal, facts.personalRecords ?? [], facts.displays);
  const personalPlugins = personal.map((g): Plugin => {
    const granted = g.connectors.every((c) => c.grantedWorkspaces.includes(facts.wsId));
    return {
      id: g.address ? `person:plugin:${g.address}` : `person:${g.connectors[0]?.serverName}`,
      ...g.display,
      ...recordFlags(g, facts.notOffered),
      owner: { kind: "person" },
      granted,
      servers: g.connectors.map(serverOf),
      skills: [],
      apps: granted ? g.connectors.flatMap(personalAppsOf) : [],
    };
  });
  return { wsId: facts.wsId, plugins: [...workspacePlugins, ...personalPlugins] };
}

/** What a plugin's record and its catalog say about it: required, or no longer offered. */
function recordFlags(
  g: Group<ConnectorFacts>,
  notOffered: ReadonlySet<string> | undefined,
): Pick<Plugin, "required" | "noLongerOffered"> {
  if (!g.address) return {};
  return {
    ...(g.required ? { required: true } : {}),
    ...(notOffered?.has(g.address) ? { noLongerOffered: true } : {}),
  };
}

/** One listed plugin: a record's connections, or one connector no record names. */
interface Group<C extends ConnectorFacts> {
  address?: string;
  required?: boolean;
  connectors: C[];
  display: Pick<Plugin, "displayName" | "description" | "iconUrl">;
}

/**
 * The connectors grouped by the record that names them, in install order,
 * then each connector no record names on its own. Each record lists every
 * installed connection it names, so a connection two plugins share is listed
 * under both. A record none of whose connections is installed here is left out.
 */
function grouped<C extends ConnectorFacts>(
  connectors: readonly C[],
  records: readonly InstalledPluginRecord[],
  displays: ReadonlyMap<string, PluginDisplay> | undefined,
): Group<C>[] {
  const claimed = new Set<string>();
  const groups: Group<C>[] = [];
  for (const record of records) {
    const names = record.connectors.map(connectionOf);
    const mine = connectors.filter((c) => names.includes(c.serverName));
    if (mine.length === 0) continue;
    for (const c of mine) claimed.add(c.serverName);
    const first = mine[0] as C;
    const listed = displays?.get(record.address);
    // One connection: it is the plugin to the person, so it shows as itself.
    const source = mine.length === 1 || !listed ? displayOf(first) : listed;
    groups.push({
      address: record.address,
      ...(record.required ? { required: true } : {}),
      connectors: mine,
      display: source,
    });
  }
  for (const c of connectors) {
    if (!claimed.has(c.serverName)) groups.push({ connectors: [c], display: displayOf(c) });
  }
  return groups;
}

function displayOf(c: ConnectorFacts | PluginDisplay): Group<ConnectorFacts>["display"] {
  return {
    displayName: c.displayName,
    ...(c.description ? { description: c.description } : {}),
    ...(c.iconUrl ? { iconUrl: c.iconUrl } : {}),
  };
}

function serverOf(c: ConnectorFacts): Plugin["servers"][number] {
  return {
    serverName: c.serverName,
    status: c.status,
    ...(c.statusReason ? { statusReason: c.statusReason } : {}),
    account: accountOf(c.identity),
  };
}

/** The display fields of a recorded identity, and nothing else it may carry. */
export function accountOf(identity: ConnectedAccountIdentity | undefined): PluginAccount | null {
  if (!identity) return null;
  const account: PluginAccount = {};
  if (typeof identity.email === "string" && identity.email) account.email = identity.email;
  if (typeof identity.name === "string" && identity.name) account.name = identity.name;
  return account.email || account.name ? account : null;
}

function skillsOf(serverName: string, facts: PluginListingFacts): PluginSkill[] {
  const kinds = [
    ["overlay", facts.overlays],
    ["published", facts.published],
  ] as const;
  return kinds.flatMap(([kind, skills]) =>
    skills
      .filter((s) => s.server === serverName)
      .map(
        (s): PluginSkill => ({
          name: s.name,
          ...(s.description ? { description: s.description } : {}),
          kind,
          serverName,
        }),
      ),
  );
}

/**
 * The views a connector places among the workspace's apps: its `sidebar.<group>`
 * placements, which the shell lists as apps (`workspaceApps` in
 * `web/src/lib/workspace-apps.ts`). Bare `sidebar` is core nav and
 * `sidebar.bottom` the utility tray; neither is an app.
 */
function appsOf(c: ConnectorFacts, facts: PluginListingFacts): PluginApp[] {
  return facts.placements
    .filter((p) => p.serverName === c.serverName && p.wsId === facts.wsId && isAppSlot(p.slot))
    .sort((a, b) => a.priority - b.priority)
    .map(
      (p): PluginApp => ({
        label: p.label || c.displayName,
        serverName: p.serverName,
        resourceUri: p.resourceUri,
        ...(p.route ? { route: p.route } : {}),
      }),
    );
}

/** Whether a placement's slot lists it as an app: `sidebar.<group>`, not core nav or the tray. */
function isAppSlot(slot: string): boolean {
  return slot.startsWith("sidebar.") && !slot.startsWith("sidebar.bottom");
}

/**
 * The views a granted personal connector's server places, by the same slot rule
 * as a workspace connector's. No `route`: a route opens through the workspace's
 * placement registry, which never holds a personal connector's views, so the
 * view is named here and opens where a tool result places it.
 */
function personalAppsOf(c: PersonalConnectorFacts): PluginApp[] {
  return (c.placements ?? [])
    .filter((p) => isAppSlot(p.slot))
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    .map(
      (p): PluginApp => ({
        label: p.label || c.displayName,
        serverName: c.serverName,
        resourceUri: p.resourceUri,
      }),
    );
}
