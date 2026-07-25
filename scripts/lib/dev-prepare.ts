/**
 * Make a checkout runnable: install what is missing, build what was never built.
 *
 * `node_modules` and `dist/` are both gitignored, so a fresh clone or worktree
 * has neither — and the README quickstart never builds bundles, so following it
 * renders the "UI not built" fallback on every bundle iframe. This runs from the
 * SHARED launcher so `dev`, `dev:empty`, `dev:minimal`, `dev:docs-demo` and
 * `dev:worktree` all get it, rather than the worktree path alone.
 *
 * Root deps are NOT handled here: this module is imported by `scripts/dev.ts`,
 * which imports from `src/`, so root `node_modules` must already exist for this
 * file to be reachable at all. `dev:worktree` installs root before spawning.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Run `bun install` in a package dir that has no `node_modules` yet. */
export function installIfMissing(label: string, dir: string): void {
  if (!existsSync(join(dir, "package.json"))) return;
  if (existsSync(join(dir, "node_modules"))) return;
  console.log(`[dev]   Installing ${label} dependencies`);
  const result = spawnSync("bun", ["install"], { cwd: dir, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[dev] Failed to install ${label}: cd ${dir} && bun install`);
    process.exit(1);
  }
}

/**
 * Install and build any bundle UI with no `dist/index.html`.
 *
 * Only what is absent. `dev` deliberately does not rebuild bundles on every
 * start, so after editing bundle source you still run `build:bundles` yourself.
 */
export function buildMissingBundleUis(repoRoot: string): void {
  const bundlesDir = join(repoRoot, "src", "bundles");
  if (!existsSync(bundlesDir)) return;

  const missing = readdirSync(bundlesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, ui: join(bundlesDir, e.name, "ui") }))
    .filter((b) => existsSync(join(b.ui, "package.json")))
    .filter((b) => !existsSync(join(b.ui, "dist", "index.html")));

  if (missing.length === 0) return;

  console.log(
    `[dev]   Building ${missing.length} bundle UI(s) with no dist: ${missing.map((b) => b.name).join(", ")}`,
  );
  for (const bundle of missing) {
    for (const args of [["install"], ["run", "build"]]) {
      const result = spawnSync("bun", args, { cwd: bundle.ui, stdio: "inherit" });
      if (result.status !== 0) {
        console.error(
          `[dev] Failed to build ${bundle.name} UI (bun ${args.join(" ")}).\n` +
            `[dev] Build it manually: cd ${bundle.ui} && bun install && bun run build`,
        );
        process.exit(1);
      }
    }
  }
}

/** Everything a checkout needs before the API and web servers start. */
export function prepareCheckout(repoRoot: string): void {
  installIfMissing("web", join(repoRoot, "web"));
  buildMissingBundleUis(repoRoot);
}
