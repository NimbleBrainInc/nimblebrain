import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve a local bundle path to an absolute directory.
 * Relative paths are resolved against configDir (if provided), otherwise CWD.
 * Returns null if the resolved path doesn't exist.
 */
export function resolveLocalBundle(path: string, configDir?: string): string | null {
  const resolved = configDir ? resolve(configDir, path) : resolve(path);
  return existsSync(resolved) ? resolved : null;
}
