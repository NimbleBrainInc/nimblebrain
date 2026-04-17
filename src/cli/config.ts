import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getValidator } from "../config/index.ts";
import type { RuntimeConfig } from "../runtime/types.ts";

const DEFAULT_CONFIG_FILE = "nimblebrain.json";

const DEFAULT_CONFIG_CONTENT = {
  $schema: "https://schemas.nimblebrain.ai/v1/nimblebrain-config.schema.json",
  version: "1",
};

export interface CliFlags {
  config?: string;
  model?: string;
  /** Default workDir when neither config file nor NB_WORK_DIR specifies one. */
  defaultWorkDir?: string;
}

/** Validate config file contents using JSON Schema. Throws on structural errors, warns on unknown keys. */
function validateConfig(config: Record<string, unknown>, path: string): void {
  const validate = getValidator();
  const valid = validate(config);

  if (!valid && validate.errors) {
    // Separate unknown-key warnings (additionalProperties) from structural errors
    const warnings: string[] = [];
    const errors: string[] = [];

    for (const err of validate.errors) {
      if (err.keyword === "additionalProperties") {
        const key = err.params?.additionalProperty ?? "unknown";
        warnings.push(key);
      } else {
        const field = err.instancePath || "(root)";
        errors.push(`${field}: ${err.message}`);
      }
    }

    for (const key of warnings) {
      console.error(`[config] Warning: unknown key "${key}" in ${path} (ignored)`);
    }

    if (errors.length > 0) {
      throw new Error(`Invalid config in ${path}:\n  - ${errors.join("\n  - ")}`);
    }
  }
}

/**
 * Resolve the config file path.
 * Priority:
 *   1. --config/-c (explicit path)
 *   2. .nimblebrain/nimblebrain.json in CWD (project-local)
 *   3. defaultWorkDir/nimblebrain.json (e.g., ~/.nimblebrain)
 *   4. nimblebrain.json in CWD (bare)
 */
function resolveConfigPath(flags: CliFlags): string {
  if (flags.config) return resolve(flags.config);
  // Check for project-local .nimblebrain/ directory first
  const localConfig = resolve(join(".nimblebrain", DEFAULT_CONFIG_FILE));
  if (existsSync(localConfig)) return localConfig;
  if (flags.defaultWorkDir) return join(resolve(flags.defaultWorkDir), DEFAULT_CONFIG_FILE);
  return resolve(DEFAULT_CONFIG_FILE);
}

/** Load RuntimeConfig from a nimblebrain.json file, merged with CLI flags. */
export function loadConfig(flags: CliFlags = {}): RuntimeConfig {
  const configPath = resolveConfigPath(flags);

  let fileConfig: Partial<RuntimeConfig> & Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    fileConfig = JSON.parse(raw);
    validateConfig(fileConfig, configPath);
  } else if (flags.config) {
    // Explicit --config/-c path must exist
    throw new Error(`Config file not found: ${configPath}`);
  } else {
    // Auto-create default config if the parent directory exists
    if (existsSync(dirname(configPath))) {
      writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG_CONTENT, null, 2)}\n`, "utf-8");
    }
  }

  // Strip workspace-owned fields — these now live in workspace.json.
  // Even if someone manually adds them to nimblebrain.json, they're ignored.
  delete fileConfig.bundles;
  delete fileConfig.agents;
  delete fileConfig.skillDirs;
  delete fileConfig.preferences;
  delete fileConfig.home;
  delete fileConfig.noDefaultBundles;
  delete fileConfig.skills; // legacy field

  // Deprecation warnings for removed fields
  if ("identity" in fileConfig) {
    console.error(
      `[config] Warning: "identity" is deprecated in ${configPath}. Use a context skill (type: "context") instead.`,
    );
  }
  if ("contextFile" in fileConfig) {
    console.error(
      `[config] Warning: "contextFile" is deprecated in ${configPath}. Use a context skill (type: "context") instead.`,
    );
  }

  // CLI flags override file config — workspace-owned fields (bundles, agents,
  // skillDirs, preferences, home, noDefaultBundles) are intentionally omitted;
  // they were deleted above and now live in workspace.json.
  const config: RuntimeConfig = {
    model: fileConfig.model ?? { provider: "anthropic" },
    providers: fileConfig.providers as RuntimeConfig["providers"],
    allowInsecureRemotes: fileConfig.allowInsecureRemotes as boolean | undefined,
    store: fileConfig.store,
    models: fileConfig.models as RuntimeConfig["models"],
    defaultModel: flags.model ?? fileConfig.defaultModel,
    maxIterations: fileConfig.maxIterations,
    maxInputTokens: fileConfig.maxInputTokens,
    maxOutputTokens: fileConfig.maxOutputTokens,
    maxHistoryMessages: fileConfig.maxHistoryMessages,
    maxToolResultSize: fileConfig.maxToolResultSize,
    events: fileConfig.events,
    logging: fileConfig.logging as RuntimeConfig["logging"],
    http: fileConfig.http as RuntimeConfig["http"],
    features: fileConfig.features as RuntimeConfig["features"],
    files: fileConfig.files as RuntimeConfig["files"],
    // Pass config path for bundle install/uninstall persistence
    configPath,
    workDir:
      process.env.NB_WORK_DIR ?? (fileConfig.workDir as string | undefined) ?? flags.defaultWorkDir,
    telemetry: fileConfig.telemetry as RuntimeConfig["telemetry"],
  };

  return config;
}
