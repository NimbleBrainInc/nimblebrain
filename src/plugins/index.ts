/**
 * Resolve the plugins an operator configured (`nimblebrain.json` `plugins`)
 * into the set the kernel would run: each plugin's manifest read and
 * validated, each of its servers placed (started from `mcp.json`, reached at
 * the operator's URL, or named by its registry entry), and every plugin's
 * contracts held to the registry and to each other.
 *
 * The kernel names no plugin here: what a plugin is comes from its own
 * manifest, what it may do from the operator's entry, and what it must
 * satisfy from the contracts it declares.
 *
 * The runtime calls {@link checkConfiguredPlugins} at boot to validate and log
 * the resolved set (the default plugins with the operator's entries over them),
 * then starts each binding's server (`bound-servers.ts`).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BUILTIN_PLUGIN_SOURCE,
  enabledPlugins,
  type PluginConfig,
  type PluginsConfig,
  withDefaultPlugins,
} from "../config/plugins.ts";
import { log } from "../observability/log.ts";
import {
  type ContractBinding,
  type ContractRegistry,
  checkContracts,
  loadContracts,
} from "./contracts.ts";
import {
  nameMap,
  PLUGIN_MANIFEST_FILE,
  type PluginManifest,
  PluginManifestError,
  type PluginServer,
  parsePluginManifest,
  readPluginDirectory,
} from "./manifest.ts";

/** Where plugins shipped with the runtime live: `packages/<name>/`, each with a root `plugin.json`. */
export const BUILTIN_PLUGINS_DIR = resolve(import.meta.dir, "../../packages");

/** One server of a resolved plugin, by its key. */
export interface ResolvedServer {
  /** How `mcp.json` says to start or reach it, when it says. */
  spec?: PluginServer;
  /** Its registry name, when the extension names one. */
  registryName?: string;
  /** Where the operator says it already runs; reached there instead of started. */
  url?: string;
}

export interface ResolvedPlugin {
  name: string;
  /** The plugin's directory, absolute. */
  root: string;
  /** Its `${PLUGIN_DATA}`: `<dataDir>/<name>`, absolute. */
  dataDir: string;
  /** The operator's decision; never the manifest's. */
  system: boolean;
  manifest: PluginManifest;
  /** Every server of the plugin, by key: `mcp.json`'s and the extension's. */
  servers: Record<string, ResolvedServer>;
}

export interface ResolvedPlugins {
  plugins: ResolvedPlugin[];
  /** Each implementation of a contract this kernel consumes that meets it. */
  bindings: ContractBinding[];
  /** Facts that refuse nothing: unknown contracts, unmet optional requirements, ignored manifest fields. */
  notes: string[];
}

/** Why the configured plugins cannot run: the plugin, and where the fault is when it is in a file. */
export interface PluginError {
  plugin: string;
  file?: string;
  field?: string;
  contract?: string;
  message: string;
}

export type ResolvePluginsResult =
  | { ok: true; resolved: ResolvedPlugins }
  | { ok: false; errors: PluginError[] };

export interface ResolvePluginsOptions {
  /** What a relative `source` resolves against: the config file's directory. */
  baseDir: string;
  /** Where each plugin's `${PLUGIN_DATA}` is: `<dataDir>/<name>`. */
  dataDir: string;
  /** Where `"builtin"` plugins live. Default {@link BUILTIN_PLUGINS_DIR}. */
  builtinDir?: string;
}

/**
 * Resolve every enabled plugin, then check their contracts together. Returns
 * every error found, across all plugins, rather than the first.
 */
export function resolvePlugins(
  config: PluginsConfig | undefined,
  contracts: ContractRegistry,
  opts: ResolvePluginsOptions,
): ResolvePluginsResult {
  const errors: PluginError[] = [];
  const plugins: ResolvedPlugin[] = [];
  const notes: string[] = [];
  for (const [name, entry] of enabledPlugins(config)) {
    const fail: Fail = (message, where = {}) => errors.push({ plugin: name, ...where, message });
    const plugin = resolvePlugin(name, entry, opts, fail);
    if (!plugin) continue;
    for (const w of plugin.manifest.warnings) notes.push(`${name}: ${w}`);
    plugins.push(plugin);
  }

  const check = checkContracts(
    plugins.map((p) => ({
      plugin: p.name,
      implements: p.manifest.extension.implements,
      requires: p.manifest.extension.requires,
    })),
    contracts,
  );
  for (const p of check.problems) {
    errors.push({ plugin: p.plugin, contract: p.contract, message: p.message });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    resolved: { plugins, bindings: check.bindings, notes: [...notes, ...check.notes] },
  };
}

type Fail = (message: string, where?: Partial<PluginError>) => void;

/** One plugin: found, read, named as configured, and its servers placed. Null after reporting why not. */
function resolvePlugin(
  name: string,
  entry: PluginConfig,
  opts: ResolvePluginsOptions,
  fail: Fail,
): ResolvedPlugin | null {
  const builtin = entry.source === BUILTIN_PLUGIN_SOURCE;
  const root = builtin
    ? join(opts.builtinDir ?? BUILTIN_PLUGINS_DIR, name)
    : resolve(opts.baseDir, entry.source);
  if (!existsSync(join(root, PLUGIN_MANIFEST_FILE))) {
    fail(
      builtin ? `no builtin plugin is named "${name}"` : `${root} holds no ${PLUGIN_MANIFEST_FILE}`,
    );
    return null;
  }

  const dataDir = join(opts.dataDir, name);
  let manifest: PluginManifest;
  try {
    manifest = parsePluginManifest(name, readPluginDirectory(root), { root, data: dataDir });
  } catch (err) {
    if (!(err instanceof PluginManifestError)) throw err;
    for (const p of err.problems) {
      fail(p.message, { file: p.file, ...(p.field ? { field: p.field } : {}) });
    }
    return null;
  }
  if (manifest.name !== name) {
    fail(`the manifest's name "${manifest.name}" is not the plugin's key "${name}"`, {
      file: PLUGIN_MANIFEST_FILE,
      field: "name",
    });
    return null;
  }

  const system = entry.system === true;
  const servers = placeServers(manifest, entry.servers ?? {}, fail);
  checkStartable(servers, system, fail);
  return { name, root, dataDir, system, manifest, servers };
}

/**
 * ADR-0076: the runtime starts a stdio server only for a system plugin, which
 * the operator chose; any other plugin's servers are reached by URL.
 */
function checkStartable(
  servers: Record<string, ResolvedServer>,
  system: boolean,
  fail: Fail,
): void {
  if (system) return;
  for (const [key, server] of Object.entries(servers)) {
    if (server.spec?.type !== "stdio" || server.url) continue;
    fail(
      `server "${key}" is a stdio server, which the runtime starts only for a system plugin; set "system": true or give it a url`,
      { field: `servers.${key}` },
    );
  }
}

/**
 * Every server of a plugin by key, with the operator's URLs applied. An
 * operator entry names a server by its key, the same key `mcp.json`, the
 * extension's `servers` and `implements[].server` use.
 */
function placeServers(
  manifest: PluginManifest,
  overrides: Record<string, { url: string }>,
  fail: Fail,
): Record<string, ResolvedServer> {
  const servers = nameMap<ResolvedServer>();
  for (const [key, spec] of Object.entries(manifest.mcpServers)) servers[key] = { spec };
  for (const [key, registryName] of Object.entries(manifest.extension.servers)) {
    servers[key] = { ...servers[key], registryName };
  }
  for (const [key, { url }] of Object.entries(overrides)) {
    const field = `servers.${key}.url`;
    if (!Object.hasOwn(servers, key)) fail(`"${key}" is not a server of the plugin`, { field });
    else if (!isHttpUrl(url)) fail("must be an absolute http or https URL", { field });
    else servers[key] = { ...servers[key], url };
  }
  return servers;
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** One error as a line: the plugin, then where, then what. */
export function formatPluginError(e: PluginError): string {
  const where = [e.file, e.field, e.contract].filter(Boolean).join(" ");
  return `${e.plugin}${where ? ` (${where})` : ""}: ${e.message}`;
}

/** Where a plugin's `${PLUGIN_DATA}` is under the runtime's work directory: `<workDir>/plugin-data/<name>`. */
export function pluginDataDir(workDir: string, name: string): string {
  return join(workDir, "plugin-data", name);
}

export interface CheckConfiguredPluginsOptions {
  /** The config file's path; a relative `source` resolves against its directory. */
  configPath?: string;
  workDir: string;
  /** Default: the contracts under `contracts/` (`loadContracts`). */
  contracts?: ContractRegistry;
  builtinDir?: string;
}

/**
 * The boot check: resolve the plugins the instance runs (the defaults, with
 * the operator's `plugins` block over them), log the resolved set, and throw
 * naming every error when they cannot run together. It starts nothing; the
 * runtime starts each binding's server from what it returns. With every plugin
 * turned off it reads nothing and returns null.
 */
export function checkConfiguredPlugins(
  configured: PluginsConfig | undefined,
  opts: CheckConfiguredPluginsOptions,
): ResolvedPlugins | null {
  const config = withDefaultPlugins(configured);
  if (enabledPlugins(config).length === 0) return null;
  const result = resolvePlugins(config, opts.contracts ?? loadContracts(), {
    baseDir: opts.configPath ? resolve(opts.configPath, "..") : process.cwd(),
    dataDir: pluginDataDir(opts.workDir, ""),
    ...(opts.builtinDir ? { builtinDir: opts.builtinDir } : {}),
  });
  if (!result.ok) {
    throw new Error(
      `[plugins] the configured plugins cannot run:\n  - ${result.errors.map(formatPluginError).join("\n  - ")}`,
    );
  }
  const { plugins, bindings, notes } = result.resolved;
  for (const p of plugins) {
    const contracts = p.manifest.extension.implements.map((i) => `${i.contract} ${i.version}`);
    log.info(
      `[plugins] resolved ${p.name}${p.system ? " (system)" : ""}${p.manifest.version ? ` ${p.manifest.version}` : ""} from ${p.root}: servers ${Object.keys(p.servers).join(", ") || "none"}${contracts.length ? `; implements ${contracts.join(", ")}` : ""}`,
    );
  }
  for (const b of bindings) {
    log.info(
      `[plugins] ${b.contract} ${b.version} is implemented by ${b.plugin} (server ${b.server})`,
    );
  }
  for (const note of notes) log.info(`[plugins] ${note}`);
  log.info(`[plugins] validated ${plugins.length} plugin(s)`);
  return result.resolved;
}
