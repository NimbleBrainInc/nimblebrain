import type { Plugin } from "../_generated/platform-schemas/plugins";

/**
 * A plugin's page, `/w/<slug>/plugins/<ref>`. The ref is the listing's `id`,
 * URL-encoded: the id is unique within the listing and stable across calls, and
 * the page finds the plugin by comparing ids, never by reading one's parts.
 */
export function pluginPath(slug: string, plugin: Pick<Plugin, "id">): string {
  return `/w/${slug}/plugins/${encodeURIComponent(plugin.id)}`;
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

/**
 * The account a plugin's row names. A person's plugin names the account it
 * signed in as, or says it is not signed in; a workspace plugin says it uses
 * the workspace's account, and which one when the sign-in recorded it. Whose
 * plugin it is reads from the row's badge, so the line does not repeat it.
 */
export function accountLine(plugin: Plugin): string | undefined {
  const account = pluginAccount(plugin);
  if (plugin.owner.kind === "workspace") {
    return account ? `Workspace account · ${account}` : "Workspace account";
  }
  if (account) return account;
  return pluginConnected(plugin) ? undefined : "Not signed in";
}

/** A skill's scope as it appears in its page's URL: the tiers a person authors in. */
export type AuthoredSkillScope = "workspace" | "user" | "org";

/**
 * A skill's page under Plugins, `/w/<slug>/plugins/skills/<scope>/<name>`. A
 * scope and a name address one authored skill: names are unique within a tier,
 * and the same name in two tiers is two skills.
 */
export function skillPath(slug: string, scope: AuthoredSkillScope, name: string): string {
  return `/w/${slug}/plugins/skills/${scope}/${encodeURIComponent(name)}`;
}

/** Where a new skill is written, `/w/<slug>/plugins/skills/new`. */
export function newSkillPath(slug: string): string {
  return `/w/${slug}/plugins/skills/new`;
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
 *   Stop using here is in its menu.
 */
export type PluginNextStep = "use_here" | "connect" | "in_use";

export function pluginNextStep(plugin: Plugin): PluginNextStep {
  if (!plugin.granted) return "use_here";
  return pluginConnected(plugin) ? "in_use" : "connect";
}

/**
 * A shell location as the same-origin path a sign-in returns to. Pages pass
 * the router's `useLocation()`; outside a route, `window.location`.
 */
export function shellPath(
  location: { pathname: string; search: string } = window.location,
): string {
  return `${location.pathname}${location.search}`;
}
