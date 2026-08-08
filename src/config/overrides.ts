/**
 * Layered config helpers: the seed file (`nimblebrain.json`, Helm-managed,
 * overwritten on every deploy by the init container) and the override file
 * (`nimblebrain.overrides.json`, sibling on the PVC, written by
 * `set_model_config`, preserved across deploys).
 *
 * The runtime loader reads both and 1-level deep-merges override over seed.
 * Override values win on every key. The override file ONLY contains the
 * subset of fields `set_model_config` knows how to write — operator-managed
 * fields (providers, auth, http, features, telemetry) belong in the seed.
 */

import { dirname, join } from "node:path";

/**
 * The only keys the override file may carry.
 *
 * The header above has always claimed this; nothing enforced it, and the claim
 * went false the moment a field stopped being writable — an override written
 * before that layers over the seed on every boot with no writer left to clear
 * it, which is precisely the git-cannot-reclaim-it failure the split exists to
 * prevent.
 *
 * Enforced in two places, from this one list: the tool refuses a field it does
 * not write, and the loader drops one that is already on disk.
 */
export const OVERRIDE_WRITABLE_KEYS = [
  "models",
  "defaultModel",
  "maxIterations",
  "maxInputTokens",
  "maxOutputTokens",
  "thinking",
  "thinkingEffort",
  "thinkingBudgetTokens",
] as const;

const DEFAULT_OVERRIDE_FILE = "nimblebrain.overrides.json";

/**
 * Derive the override-file path from the seed config path. Sibling file
 * with a fixed suffix so a deployment that mounts only `nimblebrain.json`
 * has a predictable place for runtime overrides.
 */
export function deriveOverridePath(configPath: string): string {
  return join(dirname(configPath), DEFAULT_OVERRIDE_FILE);
}

/**
 * Shallow merge with a one-level deep step for nested object values.
 *
 * Top-level scalars are replaced; top-level objects (e.g., `models`) get
 * key-by-key merged so an override of `models.fast` doesn't blow away the
 * seed's `models.default`. Arrays are replaced
 * wholesale — same as `Object.assign`.
 *
 * Deeper nesting falls back to replacement; we don't recurse arbitrarily.
 * The override file is a known small surface (set_model_config writes only
 * model-related top-level keys), so two-level merge is enough and simpler
 * than a generic deep-merge that has to reason about arrays, nulls, and
 * provider-config edge cases.
 */
export function mergeConfigs(
  seed: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...seed };
  const writable = new Set<string>(OVERRIDE_WRITABLE_KEYS);
  for (const [key, value] of Object.entries(override)) {
    // A key with no writer cannot be cleared, so it would outrank the seed
    // forever. Dropping it here restores the file to what its one writer can
    // actually produce, and a deploy reclaims the field.
    if (!writable.has(key)) continue;
    const seedValue = seed[key];
    const bothObjects =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      seedValue !== null &&
      typeof seedValue === "object" &&
      !Array.isArray(seedValue);
    if (bothObjects) {
      out[key] = {
        ...(seedValue as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      out[key] = value;
    }
  }
  return out;
}
