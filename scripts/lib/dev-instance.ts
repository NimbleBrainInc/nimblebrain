/**
 * The identity config the dev launchers give a workdir.
 *
 * `serve` refuses to start without `instance.json`, because a missing identity
 * config never selects a provider. The launchers are the one place that choice
 * is made for the developer: running `bun run dev` against a workdir with no
 * `instance.json` writes the `dev` adapter into it. A workdir that already has
 * one keeps it, so a developer can point a launcher at a real provider.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEV_INSTANCE_CONFIG = { auth: { adapter: "dev" } } as const;

/** Write the dev adapter to `<workDir>/instance.json` unless one exists. Returns the path written, or null. */
export function ensureDevInstanceConfig(workDir: string): string | null {
  const path = join(workDir, "instance.json");
  if (existsSync(path)) return null;
  mkdirSync(workDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(DEV_INSTANCE_CONFIG, null, 2)}\n`, "utf-8");
  return path;
}
