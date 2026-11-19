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

/**
 * The plugin listing (`manage_connectors` `list_plugins`) as a projection over
 * the connectors that exist today, until plugins are installed as plugins
 * (ADR-0068): each connector installed in the workspace is a workspace plugin
 * with one server, and each of the caller's personal connectors is a person's
 * plugin with one server, granted here or not (ADR-0069).
 *
 * Pure: the handler reads the facts through the code paths the other actions
 * use (`list_installed`, `list_personal_connectors`, `list_bound_skills`, the
 * placement registry) and this shapes them.
 */

/** What the listing needs of one connector, from `list_installed` or `list_personal_connectors`. */
export interface ConnectorFacts {
  serverName: string;
  displayName: string;
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

export interface PluginListingFacts {
  wsId: string;
  workspace: readonly ConnectorFacts[];
  personal: readonly PersonalConnectorFacts[];
  overlays: readonly BoundSkillFacts[];
  published: readonly BoundSkillFacts[];
  /** The workspace's placements (`PlacementRegistry.forWorkspace`). */
  placements: readonly PlacementEntry[];
}

export function projectPlugins(facts: PluginListingFacts): PluginsListOutput {
  const workspacePlugins = facts.workspace.map(
    (c): Plugin => ({
      id: `workspace:${c.serverName}`,
      displayName: c.displayName,
      ...(c.iconUrl ? { iconUrl: c.iconUrl } : {}),
      owner: { kind: "workspace" },
      granted: true,
      servers: [serverOf(c)],
      skills: skillsOf(c.serverName, facts),
      apps: appsOf(c, facts),
    }),
  );
  // A personal connector's skills and views are not composed into the
  // workspace: overlays, published skills and placements are keyed by the
  // workspace's own connectors, whose server name a personal one may share. Its
  // apps come from its own placements, and only where it is granted, since a
  // view of a plugin that does not act here cannot render here.
  const personalPlugins = facts.personal.map((c): Plugin => {
    const granted = c.grantedWorkspaces.includes(facts.wsId);
    return {
      id: `person:${c.serverName}`,
      displayName: c.displayName,
      ...(c.iconUrl ? { iconUrl: c.iconUrl } : {}),
      owner: { kind: "person" },
      granted,
      servers: [serverOf(c)],
      skills: [],
      apps: granted ? personalAppsOf(c) : [],
    };
  });
  return { wsId: facts.wsId, plugins: [...workspacePlugins, ...personalPlugins] };
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
