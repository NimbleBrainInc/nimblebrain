/**
 * Environment variable filtering for bundle processes.
 *
 * Prevents host secrets from leaking to bundle subprocesses.
 * Bundles receive only a safe allowlist of vars by default.
 * Operators can opt in specific vars per bundle via `allowedEnv`.
 */

/** Safe, non-secret vars that all bundles receive by default. */
const DEFAULT_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "NODE_ENV",
  "BUN_ENV",
  "NB_WORK_DIR",
  "UPJACK_ROOT",
  "PYTHONPATH",
  "VIRTUAL_ENV",
  "NODE_PATH",
]);

/** Vars that are never passed to bundles, even if explicitly requested. */
const HARD_DENY = new Set(["NB_API_KEY", "NB_INTERNAL_TOKEN"]);

/**
 * Build a filtered env object for a bundle process.
 *
 * 1. Picks only DEFAULT_ALLOWLIST vars from processEnv
 * 2. Adds any var in bundleAllowedEnv from processEnv (rejects HARD_DENY with stderr warning)
 * 3. Merges manifestEnv on top (bundle-declared mcp_config.env values)
 * 4. Returns the combined env object
 */
export function filterEnvForBundle(
  processEnv: Record<string, string | undefined>,
  manifestEnv?: Record<string, string>,
  bundleAllowedEnv?: string[],
): Record<string, string> {
  const result: Record<string, string> = {};

  // 1. Pick default allowlist vars from host env
  for (const key of DEFAULT_ALLOWLIST) {
    const val = processEnv[key];
    if (val !== undefined) {
      result[key] = val;
    }
  }

  // 2. Add explicitly allowed vars (respecting hard deny)
  if (bundleAllowedEnv) {
    for (const key of bundleAllowedEnv) {
      if (HARD_DENY.has(key)) {
        console.warn(`[env-filter] Denied passing ${key} to bundle — hard-deny list`);
        continue;
      }
      const val = processEnv[key];
      if (val !== undefined) {
        result[key] = val;
      }
    }
  }

  // 3. Merge manifest env on top (bundle's own mcp_config.env values)
  if (manifestEnv) {
    for (const [key, val] of Object.entries(manifestEnv)) {
      if (HARD_DENY.has(key)) {
        console.warn(`[env-filter] Denied manifest env ${key} — hard-deny list`);
        continue;
      }
      result[key] = val;
    }
  }

  return result;
}
