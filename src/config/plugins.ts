/**
 * The `plugins` block of `nimblebrain.json`: the Agent Plugins the operator
 * runs as part of this instance, where each comes from, and which are system
 * plugins (ADR-0076).
 *
 * ```json
 * { "plugins": {
 *     "conversations": { "source": "builtin", "system": true,
 *                        "servers": { "records": { "url": "http://records.internal/mcp" } } },
 *     "reports": { "source": "./plugins/reports" },
 *     "tasks": false } }
 * ```
 *
 * The block is the operator's. A plugin's manifest declares capabilities;
 * whether it runs, whether it is a system plugin, and where its servers run
 * are decided here and nowhere else. Absent, the instance runs no plugin from
 * this block and behaves as it does without one.
 */

/** The `source` that names a plugin shipped with the runtime. */
export const BUILTIN_PLUGIN_SOURCE = "builtin";

/** Where one of a plugin's servers already runs, so the runtime reaches it instead of starting it. */
export interface PluginServerConfig {
  /** Its MCP endpoint, reached over Streamable HTTP. */
  url: string;
}

/** One plugin, as an operator writes it. */
export interface PluginConfig {
  /**
   * `"builtin"` for the plugin of this name shipped with the runtime, or a
   * directory holding its `plugin.json`, relative to the config file's directory.
   */
  source: string;
  /**
   * A system plugin holds records the kernel relies on and sees other
   * plugins' data by design. Only this field makes one; a manifest cannot.
   */
  system?: boolean;
  /** By a role of a contract the plugin implements, or by its server key. */
  servers?: Record<string, PluginServerConfig>;
}

/** The `plugins` block: plugin name → its entry, or `false` for off. */
export type PluginsConfig = Record<string, PluginConfig | false>;

/** Every key of a plugin entry, for the config schema drift guard. */
export const PLUGIN_CONFIG_KEYS = Object.keys({
  source: true,
  system: true,
  servers: true,
} satisfies Record<keyof PluginConfig, true>);

/** Every key of a server entry, for the config schema drift guard. */
export const PLUGIN_SERVER_CONFIG_KEYS = Object.keys({
  url: true,
} satisfies Record<keyof PluginServerConfig, true>);

/** The plugins to load, in the order the block lists them; `false` entries are left out. */
export function enabledPlugins(config: PluginsConfig | undefined): Array<[string, PluginConfig]> {
  return Object.entries(config ?? {}).flatMap(([name, entry]) =>
    entry === false ? [] : [[name, entry] as [string, PluginConfig]],
  );
}
