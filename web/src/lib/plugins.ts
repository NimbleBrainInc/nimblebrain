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

/** Whose account the plugin acts as, and which one when the sign-in recorded it. */
export function accountLine(plugin: Plugin): string {
  const account = pluginAccount(plugin);
  return account ? `${ownerLine(plugin)} · ${account}` : ownerLine(plugin);
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
