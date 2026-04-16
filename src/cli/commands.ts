import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadCoreSkills, loadSkillDir, partitionSkills } from "../skills/loader.ts";
import type { Skill } from "../skills/types.ts";
import { TelemetryManager } from "../telemetry/manager.ts";

const DEFAULT_CONFIG_FILE = "nimblebrain.json";
const MPAK_CONFIG_PATH = join(homedir(), ".mpak", "config.json");
const RELOAD_SENTINEL = join(homedir(), ".nimblebrain", ".reload");

interface Config {
  bundles?: Array<{
    name?: string;
    path?: string;
    url?: string;
    serverName?: string;
    transport?: Record<string, unknown>;
    env?: Record<string, string>;
  }>;
  skillDirs?: string[];
  [key: string]: unknown;
}

function loadNbConfig(configPath?: string): { config: Config; path: string } {
  const p = resolve(configPath ?? DEFAULT_CONFIG_FILE);
  if (!existsSync(p)) return { config: { bundles: [] }, path: p };
  return { config: JSON.parse(readFileSync(p, "utf-8")), path: p };
}

function saveNbConfig(config: Config, path: string): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** nb bundle list */
export function bundleList(configPath?: string, json?: boolean): void {
  const { config } = loadNbConfig(configPath);
  const bundles = config.bundles ?? [];
  if (json) {
    process.stdout.write(`${JSON.stringify(bundles)}\n`);
    return;
  }
  if (bundles.length === 0) {
    console.log("No bundles configured.");
    return;
  }
  console.log("Configured bundles:\n");
  for (const b of bundles) {
    const name = b.name ?? b.path ?? b.url ?? "unknown";
    const type = b.name ? "named" : b.url ? "remote" : "local";
    console.log(`  ${name} (${type})`);
  }
}

/** nb bundle add <name> — deprecated, bundles are now workspace-scoped */
export function bundleAdd(name: string, _configPath?: string): void {
  console.error(
    `Instance-level bundles have been removed. Use workspace-scoped bundle management instead:\n` +
      `  nb__manage_app install ${name}\n` +
      `Or add the bundle to your workspace definition.`,
  );
  process.exit(1);
}

/** nb bundle add --url — deprecated, bundles are now workspace-scoped */
export function bundleAddRemote(
  _url: string,
  _serverName: string,
  _auth?: string,
  _token?: string,
  _configPath?: string,
): void {
  console.error(
    "Instance-level bundles have been removed. Use workspace-scoped bundle management instead.",
  );
  process.exit(1);
}

/** nb bundle remove <name> — deprecated, bundles are now workspace-scoped */
export function bundleRemove(name: string, _configPath?: string): void {
  console.error(
    `Instance-level bundles have been removed. Use workspace-scoped bundle management instead:\n` +
      `  nb__manage_app uninstall ${name}\n` +
      `Or remove the bundle from your workspace definition.`,
  );
  process.exit(1);
}

/** nb bundle search <query> - delegates to mpak */
export function bundleSearch(query: string): void {
  console.log(`Searching mpak registry for "${query}"...`);
  console.log(`Run: mpak search "${query}"`);
}

/** nb skill list */
export function skillList(configPath?: string, json?: boolean): void {
  const { config } = loadNbConfig(configPath);
  const core = loadCoreSkills();
  const dirs = config.skillDirs ?? [];
  const userSkills: Skill[] = [];
  for (const dir of dirs) {
    userSkills.push(...loadSkillDir(dir));
  }
  const all = [...core, ...userSkills];
  const { context, skills } = partitionSkills(all);

  if (json) {
    const output = [...context, ...skills].map((s) => ({
      name: s.manifest.name,
      type: s.manifest.type,
      priority: s.manifest.priority,
      source: s.sourcePath,
      description: s.manifest.description,
    }));
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  console.log("NAME              TYPE      PRIORITY  SOURCE");
  for (const s of [...context, ...skills]) {
    const name = s.manifest.name.padEnd(18);
    const type = s.manifest.type.padEnd(10);
    const priority = String(s.manifest.priority).padEnd(10);
    const source = s.sourcePath;
    console.log(`${name}${type}${priority}${source}`);
  }
}

/** nb skill info <name> */
export function skillInfo(name: string, configPath?: string): void {
  const { config } = loadNbConfig(configPath);
  const core = loadCoreSkills();
  const dirs = config.skillDirs ?? [];
  const userSkills: Skill[] = [];
  for (const dir of dirs) {
    userSkills.push(...loadSkillDir(dir));
  }
  const all = [...core, ...userSkills];
  const skill = all.find((s) => s.manifest.name === name);
  if (!skill) {
    console.log(`Skill "${name}" not found.`);
    return;
  }
  console.log(`Name: ${skill.manifest.name}`);
  console.log(`Type: ${skill.manifest.type}`);
  console.log(`Priority: ${skill.manifest.priority}`);
  console.log(`Description: ${skill.manifest.description}`);
  console.log(`Source: ${skill.sourcePath}`);
  if (skill.manifest.allowedTools?.length) {
    console.log(`Allowed tools: ${skill.manifest.allowedTools.join(", ")}`);
  }
  console.log(`\n--- Body ---\n${skill.body.slice(0, 500)}`);
}

/** nb status */
export function status(configPath?: string, json?: boolean): void {
  const { config } = loadNbConfig(configPath);
  const bundles = config.bundles ?? [];
  const core = loadCoreSkills();
  const dirs = config.skillDirs ?? [];
  const userSkills: Skill[] = [];
  for (const dir of dirs) {
    userSkills.push(...loadSkillDir(dir));
  }
  const all = [...core, ...userSkills];

  if (json) {
    const output = {
      bundles,
      skills: all.map((s) => ({
        name: s.manifest.name,
        type: s.manifest.type,
        priority: s.manifest.priority,
        source: s.sourcePath,
        description: s.manifest.description,
      })),
    };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return;
  }

  console.log(`Bundles: ${bundles.length} configured`);
  for (const b of bundles) {
    console.log(`  ${b.name ?? b.path ?? "unknown"}`);
  }
  console.log(`Skills: ${all.length} loaded`);
}

/** nb reload */
export function reload(): void {
  const dir = join(homedir(), ".nimblebrain");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(RELOAD_SENTINEL, new Date().toISOString());
  console.log("Reload signal sent. Running runtime will pick up changes.");
}

/** nb config set @scope/name key=value */
export function configSet(bundleName: string, keyValue: string): void {
  const [key, value] = keyValue.split("=", 2);
  if (!key || value === undefined) {
    console.error("Usage: nb config set @scope/name key=value");
    return;
  }

  let mpakConfig: Record<string, unknown> = {};
  if (existsSync(MPAK_CONFIG_PATH)) {
    mpakConfig = JSON.parse(readFileSync(MPAK_CONFIG_PATH, "utf-8"));
  }
  const packages = (mpakConfig.packages ?? {}) as Record<string, Record<string, string>>;
  if (!packages[bundleName]) packages[bundleName] = {};
  packages[bundleName]![key] = value;
  mpakConfig.packages = packages;

  const dir = join(homedir(), ".mpak");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(MPAK_CONFIG_PATH, `${JSON.stringify(mpakConfig, null, 2)}\n`, { mode: 0o600 });
  console.log(`Saved ${key} for ${bundleName}`);
}

/** nb config get @scope/name */
export function configGet(bundleName: string): void {
  if (!existsSync(MPAK_CONFIG_PATH)) {
    console.log("No config found.");
    return;
  }
  const mpakConfig = JSON.parse(readFileSync(MPAK_CONFIG_PATH, "utf-8"));
  const packages = mpakConfig.packages ?? {};
  const bundle = packages[bundleName];
  if (!bundle) {
    console.log(`No config for ${bundleName}`);
    return;
  }
  for (const [key, value] of Object.entries(bundle as Record<string, string>)) {
    const masked = value.length > 4 ? `${value.slice(0, 2)}****` : "****";
    console.log(`${key}: ${masked}`);
  }
}

/** nb config clear @scope/name key */
export function configClear(bundleName: string, key: string): void {
  if (!existsSync(MPAK_CONFIG_PATH)) {
    console.log("No config found.");
    return;
  }
  const mpakConfig = JSON.parse(readFileSync(MPAK_CONFIG_PATH, "utf-8"));
  const packages = mpakConfig.packages ?? {};
  if (packages[bundleName]) {
    delete packages[bundleName][key];
    if (Object.keys(packages[bundleName]).length === 0) {
      delete packages[bundleName];
    }
  }
  mpakConfig.packages = packages;
  writeFileSync(MPAK_CONFIG_PATH, `${JSON.stringify(mpakConfig, null, 2)}\n`, { mode: 0o600 });
  console.log(`Cleared ${key} for ${bundleName}`);
}

/** nb telemetry on */
export function telemetryOn(configPath?: string): void {
  const { config, path } = loadNbConfig(configPath);
  if (!config.telemetry) config.telemetry = {};
  (config.telemetry as Record<string, unknown>).enabled = true;
  saveNbConfig(config, path);
  console.log("Telemetry enabled.");
}

/** nb telemetry off */
export function telemetryOff(configPath?: string): void {
  const { config, path } = loadNbConfig(configPath);
  if (!config.telemetry) config.telemetry = {};
  (config.telemetry as Record<string, unknown>).enabled = false;
  saveNbConfig(config, path);
  console.log("Telemetry disabled.");
}

/** nb telemetry status */
export function telemetryStatus(configPath?: string, workDir?: string): void {
  const { config } = loadNbConfig(configPath);
  const resolvedWorkDir = workDir ?? join(homedir(), ".nimblebrain");
  const telConfig = (config.telemetry ?? {}) as Record<string, unknown>;
  const envDisabled = process.env.NB_TELEMETRY_DISABLED === "1" || process.env.DO_NOT_TRACK === "1";
  const configDisabled = telConfig.enabled === false;
  const enabled = !envDisabled && !configDisabled;

  const idPath = join(resolvedWorkDir, ".telemetry-id");
  let anonymousId = "not yet created";
  if (existsSync(idPath)) {
    anonymousId = readFileSync(idPath, "utf-8").trim();
  }

  console.log(`Telemetry: ${enabled ? "enabled" : "disabled"}`);
  if (envDisabled) console.log("  (disabled via environment variable)");
  if (configDisabled) console.log("  (disabled via config)");
  console.log(`Anonymous ID: ${anonymousId}`);
  console.log(`ID file: ${idPath}`);
  console.log();
  console.log("Events sent:");
  console.log("  - CLI commands (command name, mode, flag names)");
  console.log("  - Agent loop (iterations, tool count, latency, stop reason)");
  console.log("  - Bundle lifecycle (install/uninstall/crash counts)");
  console.log("  - Errors (error type only)");
  console.log();
  console.log("Never sent:");
  console.log("  - Conversation content, file paths, tool arguments");
  console.log("  - Usernames, hostnames, IP addresses");
  console.log("  - Bundle names, skill names, model names");
  console.log();
  console.log("Destination: PostHog (https://us.i.posthog.com)");
}

/** nb telemetry reset */
export function telemetryReset(workDir?: string): void {
  const resolvedWorkDir = workDir ?? join(homedir(), ".nimblebrain");
  const newId = TelemetryManager.resetId(resolvedWorkDir);
  console.log(`Anonymous ID reset: ${newId}`);
}
