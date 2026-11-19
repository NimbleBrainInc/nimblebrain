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
