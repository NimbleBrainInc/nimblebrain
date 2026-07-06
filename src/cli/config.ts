import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getValidator } from "../config/index.ts";
import { deriveOverridePath, mergeConfigs } from "../config/overrides.ts";
import { log } from "../observability/log.ts";
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

/**
 * Validate config file contents using JSON Schema. Throws on structural
 * errors. Warns on unknown keys when `warnUnknownKeys` is true (default).
 *
 * The override file is written by `set_model_config` and contains a known
 * small surface — its valid keys (e.g., `thinking`, `thinkingBudgetTokens`)
 * are not yet in the published JSON schema, so unknown-key warnings would
 * fire on every boot for any tenant that's run `set_model_config`. The
 * structural validation (type errors) still fires; only the key-name
 * warning is suppressed for that file.
 */
function validateConfig(
  config: Record<string, unknown>,
  path: string,
  opts: { warnUnknownKeys?: boolean } = {},
): void {
  const warnUnknownKeys = opts.warnUnknownKeys ?? true;
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

    if (warnUnknownKeys) {
      for (const key of warnings) {
        log.error(`[config] Warning: unknown key "${key}" in ${path} (ignored)`);
      }
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

/** File-derived config: RuntimeConfig fields plus any extra keys read off disk. */
type FileConfig = Partial<RuntimeConfig> & Record<string, unknown>;

/** Read+validate the seed config, auto-creating a default when its dir exists. */
function loadSeedConfig(configPath: string, flags: CliFlags): Record<string, unknown> {
  if (existsSync(configPath)) {
    const seedConfig: Record<string, unknown> = JSON.parse(readFileSync(configPath, "utf-8"));
    validateConfig(seedConfig, configPath);
    return seedConfig;
  }
  if (flags.config) {
    // Explicit --config/-c path must exist
    throw new Error(`Config file not found: ${configPath}`);
  }
  // Auto-create default config if the parent directory exists
  if (existsSync(dirname(configPath))) {
    writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG_CONTENT, null, 2)}\n`, "utf-8");
  }
  return {};
}

/** Layer the user-managed override file over the operator seed; override keys win. */
function applyOverride(
  seedConfig: Record<string, unknown>,
  configOverridePath: string,
): FileConfig {
  const fileConfig = seedConfig as FileConfig;
  if (!existsSync(configOverridePath)) return fileConfig;
  // A malformed override file must NOT take down startup — the seed is still
  // valid and the operator can fix the override later. Log loudly on failure.
  try {
    const override = JSON.parse(readFileSync(configOverridePath, "utf-8")) as Record<
      string,
      unknown
    >;
    // Suppress unknown-key warnings: the override file's vocabulary (thinking,
    // thinkingBudgetTokens) is not yet in the published JSON schema, and warning
    // every boot for every tenant that's run set_model_config is noise.
    // Structural errors still throw.
    validateConfig(override, configOverridePath, { warnUnknownKeys: false });
    const overrideKeys = Object.keys(override);
    if (overrideKeys.length === 0) return fileConfig;
    log.error(
      `[config] Applied ${overrideKeys.length} runtime override${overrideKeys.length === 1 ? "" : "s"} from ${configOverridePath}: ${overrideKeys.join(", ")}`,
    );
    return mergeConfigs(seedConfig, override) as FileConfig;
  } catch (err) {
    log.error(
      `[config] Failed to load override file ${configOverridePath}: ${err instanceof Error ? err.message : String(err)}. Using seed config only.`,
    );
    return fileConfig;
  }
}

/** Delete workspace-owned fields; they now live in workspace.json and are ignored here. */
function stripWorkspaceFields(fileConfig: FileConfig): void {
  delete fileConfig.bundles;
  delete fileConfig.agents;
  delete fileConfig.skillDirs;
  delete fileConfig.preferences;
  delete fileConfig.home;
  delete fileConfig.noDefaultBundles;
  delete fileConfig.skills; // legacy field
}

/** Emit deprecation warnings for removed fields still present in the file. */
function warnDeprecatedFields(fileConfig: FileConfig, configPath: string): void {
  if ("identity" in fileConfig) {
    log.error(
      `[config] Warning: "identity" is deprecated in ${configPath}. Use a context skill (type: "context") instead.`,
    );
  }
  if ("contextFile" in fileConfig) {
    log.error(
      `[config] Warning: "contextFile" is deprecated in ${configPath}. Use a context skill (type: "context") instead.`,
    );
  }
}

/** Resolve workDir (NB_WORK_DIR > file > flag default), absolutized at load. */
function absoluteWorkDir(fileConfig: FileConfig, flags: CliFlags): string | undefined {
  // Absolutize so the value survives crossing process boundaries (e.g. as
  // `MPAK_WORKSPACE` to bundle subprocesses with a different cwd) without the
  // two ends resolving against different bases. The undefined case is
  // preserved — `resolveWorkDir(config)` in runtime.ts falls back to
  // `DEFAULT_WORK_DIR`, which is already absolute.
  const raw =
    process.env.NB_WORK_DIR ?? (fileConfig.workDir as string | undefined) ?? flags.defaultWorkDir;
  return raw === undefined ? undefined : resolve(raw);
}

/** Load RuntimeConfig from a nimblebrain.json file, merged with CLI flags. */
export function loadConfig(flags: CliFlags = {}): RuntimeConfig {
  const configPath = resolveConfigPath(flags);
  const configOverridePath = deriveOverridePath(configPath);

  // The seed is operator-managed and overwritten on every deploy by the init
  // container; the override is user-managed (set_model_config writes it) and
  // preserved across deploys. Override values win on every key.
  const seedConfig = loadSeedConfig(configPath, flags);
  const fileConfig = applyOverride(seedConfig, configOverridePath);

  stripWorkspaceFields(fileConfig);
  warnDeprecatedFields(fileConfig, configPath);

  // CLI flags override file config — workspace-owned fields (bundles, agents,
  // skillDirs, preferences, home, noDefaultBundles) are intentionally omitted;
  // they were deleted above and now live in workspace.json.
  const config: RuntimeConfig = {
    model: fileConfig.model ?? { provider: "anthropic" },
    providers: fileConfig.providers as RuntimeConfig["providers"],
    allowInsecureRemotes: fileConfig.allowInsecureRemotes as boolean | undefined,
    models: fileConfig.models as RuntimeConfig["models"],
    defaultModel: flags.model ?? fileConfig.defaultModel,
    maxIterations: fileConfig.maxIterations,
    maxInputTokens: fileConfig.maxInputTokens,
    maxOutputTokens: fileConfig.maxOutputTokens,
    maxHistoryMessages: fileConfig.maxHistoryMessages,
    maxToolResultSize: fileConfig.maxToolResultSize,
    thinking: fileConfig.thinking as RuntimeConfig["thinking"],
    thinkingBudgetTokens: fileConfig.thinkingBudgetTokens as RuntimeConfig["thinkingBudgetTokens"],
    events: fileConfig.events,
    logging: fileConfig.logging as RuntimeConfig["logging"],
    http: fileConfig.http as RuntimeConfig["http"],
    features: fileConfig.features as RuntimeConfig["features"],
    files: fileConfig.files as RuntimeConfig["files"],
    // Pass config path for bundle install/uninstall persistence
    configPath,
    configOverridePath,
    workDir: absoluteWorkDir(fileConfig, flags),
    telemetry: fileConfig.telemetry as RuntimeConfig["telemetry"],
  };

  return config;
}
