/**
 * The trees whose CSS the host themes, and the walk over their source.
 *
 * Shared because two guards assert different things about the same set —
 * {@link ./theme-token-names.test.ts} that every token name resolves, and
 * {@link ./token-fallbacks.test.ts} that no call site carries a fallback — and
 * a set defined twice is a set that gets extended once. Registering a new
 * themed tree with the guard you happen to hit first would leave the other
 * silently not scanning it, which is the failure both guards exist to prevent,
 * one level up from where they prevent it.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const REPO = join(import.meta.dir, "..", "..", "..");
const BUNDLES = join(REPO, "src", "bundles");

/**
 * Every `.ts`/`.tsx`/`.css` file under a tree. All three extensions matter:
 * `automations` keeps its whole stylesheet in a `styles.ts` template string and
 * its components carry inline `style` props, so a `*.css` glob reads none of it
 * — which is how a sweep missed that bundle entirely.
 */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === "dist" || entry === "node_modules") return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(entry) ? [path] : [];
  });
}

/**
 * Every tree whose CSS is injected with `buildThemeStyleBlock`: the bundle UIs,
 * plus the `ui://nb/*` resources rendered from `src/tools/core-resources`,
 * which go through `iframe.ts::injectThemeStyles` and read the same names.
 *
 * The bundle half is derived rather than listed, so a new bundle is covered on
 * creation. Add an entry here only for a tree outside `src/bundles` that renders
 * host-themed markup — and only when it actually does: `scripts/` was carried
 * here on that rationale while containing no `var()` read, no `ui://` resource,
 * and no markup at all.
 */
export const themedTrees = [
  ...readdirSync(BUNDLES).map((name) => ({ name, dir: join(BUNDLES, name, "ui", "src") })),
  { name: "core-resources", dir: join(REPO, "src", "tools", "core-resources") },
].filter(({ dir }) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
});
