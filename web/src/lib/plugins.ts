import type { Plugin } from "../_generated/platform-schemas/plugins";

/**
 * A plugin's page, `/w/<slug>/plugins/<ref>`. The ref is the listing's `id`,
 * URL-encoded: the id is unique within the listing and stable across calls, and
 * the page finds the plugin by comparing ids, never by reading one's parts.
 */
export function pluginPath(slug: string, plugin: Pick<Plugin, "id">): string {
  return `/w/${slug}/plugins/${encodeURIComponent(plugin.id)}`;
}

/**
 * The workspace plugin that holds a workspace connector, by its server name: a
 * server name does not name its plugin, so it is found in the listing.
 */
export function workspacePluginForServer(
  plugins: readonly Plugin[],
  serverName: string,
): Plugin | undefined {
  return plugins.find(
    (p) => p.owner.kind === "workspace" && p.servers.some((s) => s.serverName === serverName),
  );
}

/** The account the plugin signs in as: the first of its servers that records one. */
export function pluginAccount(plugin: Plugin): string | undefined {
  for (const server of plugin.servers) {
    const account = server.account?.email ?? server.account?.name;
    if (account) return account;
  }
  return undefined;
}

/** Whose account the plugin acts as. */
export function ownerLine(plugin: Plugin): string {
  return plugin.owner.kind === "person" ? "Uses your account" : "Uses the workspace's account";
}

/** A skill's scope as it appears in its page's URL: the tiers a person authors in. */
export type AuthoredSkillScope = "workspace" | "user" | "org";

/** The workspace's Plugins page, `/w/<slug>/plugins`. */
export function pluginsPath(slug: string): string {
  return `/w/${slug}/plugins`;
}

/** The plugin directory, `/w/<slug>/plugins/browse`. */
export function browsePluginsPath(slug: string): string {
  return `/w/${slug}/plugins/browse`;
}

/**
 * One directory entry's page, `/w/<slug>/plugins/browse/<catalog id>`. A catalog
 * id is the registry's reverse-DNS name and carries a `/` (`com.notion/mcp`), so
 * it is the route's splat: each segment is encoded and the slashes stay.
 */
export function browsePluginPath(slug: string, catalogId: string): string {
  const id = catalogId.split("/").map(encodeURIComponent).join("/");
  return `${browsePluginsPath(slug)}/${id}`;
}

/** The workspace's Skills page, `/w/<slug>/skills`. */
export function skillsPath(slug: string): string {
  return `/w/${slug}/skills`;
}

/**
 * A skill's page, `/w/<slug>/skills/<scope>/<name>`. A scope and a name address
 * one authored skill: names are unique within a tier, and the same name in two
 * tiers is two skills.
 */
export function skillPath(slug: string, scope: AuthoredSkillScope, name: string): string {
  return `/w/${slug}/skills/${scope}/${encodeURIComponent(name)}`;
}

/** Where a new skill is written, `/w/<slug>/skills/new`. */
export function newSkillPath(slug: string): string {
  return `/w/${slug}/skills/new`;
}

/** Whether every server of the plugin is signed in and running. */
export function pluginConnected(plugin: Plugin): boolean {
  return plugin.servers.every((s) => s.status === "ready");
}

/**
 * The one thing a person's plugin asks of its owner in a workspace, which its
 * primary action does:
 *
 * - `use_here`: not on here. Use here turns it on, then signs in when it is not
 *   connected (`pluginConnected`), so it never lands on with no account behind it.
 * - `connect`: on here, not signed in. Connect signs in.
 * - `in_use`: on here and signed in. Nothing to do, so the row offers nothing;
 *   Stop using here is on its page.
 */
export type PluginNextStep = "use_here" | "connect" | "in_use";

export function pluginNextStep(plugin: Plugin): PluginNextStep {
  if (!plugin.granted) return "use_here";
  return pluginConnected(plugin) ? "in_use" : "connect";
}
