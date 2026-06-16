import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getValidator } from "../config/index.ts";
import { deriveOverridePath, mergeConfigs } from "../config/overrides.ts";
import type { RuntimeConfig } from "../runtime/types.ts";
import { log } from "./log.ts";

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

/** Load RuntimeConfig from a nimblebrain.json file, merged with CLI flags. */
export function loadConfig(flags: CliFlags = {}): RuntimeConfig {
  const configPath = resolveConfigPath(flags);
  const configOverridePath = deriveOverridePath(configPath);

  let seedConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    seedConfig = JSON.parse(raw);
    validateConfig(seedConfig, configPath);
  } else if (flags.config) {
    // Explicit --config/-c path must exist
    throw new Error(`Config file not found: ${configPath}`);
  } else {
    // Auto-create default config if the parent directory exists
    if (existsSync(dirname(configPath))) {
      writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG_CONTENT, null, 2)}\n`, "utf-8");
    }
  }

  // Layer the override file (if present) over the seed. The override is
  // user-managed (set_model_config writes here) and preserved across
  // deploys; the seed is operator-managed and overwritten on every deploy
  // by the init container. Override values win on every key.
  let fileConfig: Partial<RuntimeConfig> & Record<string, unknown> =
    seedConfig as Partial<RuntimeConfig> & Record<string, unknown>;
  if (existsSync(configOverridePath)) {
    try {
      const overrideRaw = readFileSync(configOverridePath, "utf-8");
      const override = JSON.parse(overrideRaw) as Record<string, unknown>;
      // Suppress unknown-key warnings: the override file's vocabulary
      // (thinking, thinkingBudgetTokens) is not yet in the published
      // JSON schema, and warning every boot for every tenant that's
      // run set_model_config is noise. Structural errors still throw.
      validateConfig(override, configOverridePath, { warnUnknownKeys: false });
      const overrideKeys = Object.keys(override);
      if (overrideKeys.length > 0) {
        fileConfig = mergeConfigs(seedConfig, override) as Partial<RuntimeConfig> &
          Record<string, unknown>;
        log.error(
          `[config] Applied ${overrideKeys.length} runtime override${overrideKeys.length === 1 ? "" : "s"} from ${configOverridePath}: ${overrideKeys.join(", ")}`,
        );
      }
    } catch (err) {
      // A malformed override file should NOT take down startup — the seed
      // is still valid and the operator can fix the override file later.
      // Log loudly so the divergence is visible.
      log.error(
        `[config] Failed to load override file ${configOverridePath}: ${err instanceof Error ? err.message : String(err)}. Using seed config only.`,
      );
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
    log.error(
      `[config] Warning: "identity" is deprecated in ${configPath}. Use a context skill (type: "context") instead.`,
    );
  }
  if ("contextFile" in fileConfig) {
    log.error(
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
    // Absolutize at load so the value can be passed across process boundaries
    // (e.g. as `MPAK_WORKSPACE` to bundle subprocesses with a different cwd)
    // without the two ends resolving against different bases. The undefined
    // case is preserved — `resolveWorkDir(config)` in runtime.ts falls back to
    // `DEFAULT_WORK_DIR`, which is already absolute.
    workDir: ((): string | undefined => {
      const raw =
        process.env.NB_WORK_DIR ??
        (fileConfig.workDir as string | undefined) ??
        flags.defaultWorkDir;
      return raw === undefined ? undefined : resolve(raw);
    })(),
    telemetry: fileConfig.telemetry as RuntimeConfig["telemetry"],
  };

  return config;
}
