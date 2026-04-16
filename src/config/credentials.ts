import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigField, ConfirmationGate } from "./privilege.ts";

const MPAK_CONFIG_PATH = join(homedir(), ".mpak", "config.json");

interface UserConfigSchema {
  [key: string]: {
    type: string;
    title?: string;
    description?: string;
    sensitive?: boolean;
    required?: boolean;
  };
}

/**
 * Resolve user_config values for a bundle manifest.
 *
 * 1. Read stored values from ~/.mpak/config.json
 * 2. For missing required/optional values: prompt via gate (if interactive)
 * 3. Save prompted values back to config
 * 4. Substitute ${user_config.key} in env vars
 *
 * Returns resolved env vars ready to pass to McpSource.
 */
export async function resolveCredentials(
  bundleName: string,
  userConfig: UserConfigSchema | undefined,
  manifestEnv: Record<string, string>,
  gate: ConfirmationGate,
  forcePrompt = false,
): Promise<Record<string, string>> {
  if (!userConfig || Object.keys(userConfig).length === 0) {
    return manifestEnv;
  }

  const stored = loadStoredConfig(bundleName);
  const resolved: Record<string, string> = { ...stored };

  for (const [key, field] of Object.entries(userConfig)) {
    if (resolved[key] && !forcePrompt) continue; // Already have it

    if (!gate.supportsInteraction) {
      if (field.required !== false) {
        throw new Error(
          `Missing required config "${field.title ?? key}" for ${bundleName}. ` +
            `Run: nb config set ${bundleName} ${key}=VALUE`,
        );
      }
      continue;
    }

    // Prompt via TUI gate
    const configField: ConfigField = {
      key,
      title: field.title,
      description: field.description,
      sensitive: field.sensitive,
      required: field.required,
    };

    const value = await gate.promptConfigValue(configField);
    if (value) {
      resolved[key] = value;
      saveStoredConfig(bundleName, key, value);
    } else if (field.required !== false) {
      throw new Error(
        `Required config "${field.title ?? key}" was not provided for ${bundleName}.`,
      );
    }
  }

  // Substitute ${user_config.key} in manifest env
  const finalEnv: Record<string, string> = {};
  for (const [envKey, envValue] of Object.entries(manifestEnv)) {
    finalEnv[envKey] = envValue.replace(
      /\$\{user_config\.(\w+)\}/g,
      (_, configKey: string) => resolved[configKey] ?? "",
    );
  }

  return finalEnv;
}

function loadStoredConfig(bundleName: string): Record<string, string> {
  try {
    if (!existsSync(MPAK_CONFIG_PATH)) return {};
    const data = JSON.parse(readFileSync(MPAK_CONFIG_PATH, "utf-8"));
    return (data.packages?.[bundleName] as Record<string, string>) ?? {};
  } catch {
    return {};
  }
}

function saveStoredConfig(bundleName: string, key: string, value: string): void {
  try {
    const dir = join(homedir(), ".mpak");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    let data: Record<string, unknown> = {};
    if (existsSync(MPAK_CONFIG_PATH)) data = JSON.parse(readFileSync(MPAK_CONFIG_PATH, "utf-8"));

    const packages = (data.packages ?? {}) as Record<string, Record<string, string>>;
    if (!packages[bundleName]) packages[bundleName] = {};
    packages[bundleName]![key] = value;
    data.packages = packages;

    writeFileSync(MPAK_CONFIG_PATH, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.error("[credentials] failed to save config:", err);
  }
}
