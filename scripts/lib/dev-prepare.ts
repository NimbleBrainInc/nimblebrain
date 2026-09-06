/**
 * Make a checkout runnable: install what is missing, build what was never built.
 *
 * `node_modules` and `dist/` are both gitignored, so a fresh clone or worktree
 * has neither — and the README quickstart never builds the platform app UIs, so
 * following it renders the "UI not built" fallback in every app iframe. This runs from the
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

/**
 * Run `bun install` in a package dir that has no `node_modules` yet.
 *
 * `prefix` is the caller's log tag: this runs from two launchers, and a line
 * tagged with the wrong one is the first thing a fresh worktree prints.
 */
export function installIfMissing(label: string, dir: string, prefix = "[dev]"): void {
  if (!existsSync(join(dir, "package.json"))) return;
  if (existsSync(join(dir, "node_modules"))) return;
  console.log(`${prefix}   Installing ${label} dependencies`);
  const result = spawnSync("bun", ["install"], { cwd: dir, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${prefix} Failed to install ${label}: cd ${dir} && bun install`);
    process.exit(1);
  }
}

/**
 * Install and build any platform app UI with no `dist/index.html`.
 *
 * Only what is absent. `dev` deliberately does not rebuild the app UIs on every
 * start, so after editing one you still run `build:platform-apps` yourself.
 *
 * This does NOT delegate to `bun run build:platform-apps`, which is the obvious
 * de-duplication and the wrong one: that script rebuilds every app UI
 * unconditionally, which is correct for CI parity and wrong here. Selectivity
 * is this module's only new idea — deleting a stray dist should cost one build,
 * not five. The layout convention is duplicated on purpose; the alternative is
 * a dev path that either over-builds or makes CI depend on dev tooling.
 */
export function appUisMissingDist(repoRoot: string): { name: string; ui: string }[] {
  const appsDir = join(repoRoot, "src", "platform");
  if (!existsSync(appsDir)) return [];

  return readdirSync(appsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, ui: join(appsDir, e.name, "ui") }))
    .filter((a) => existsSync(join(a.ui, "package.json")))
    .filter((a) => !existsSync(join(a.ui, "dist", "index.html")));
}

export function buildMissingAppUis(repoRoot: string): void {
  const missing = appUisMissingDist(repoRoot);
  if (missing.length === 0) return;

  console.log(
    `[dev]   Building ${missing.length} platform app UI(s) with no dist: ${missing.map((a) => a.name).join(", ")}`,
  );
  for (const app of missing) {
    for (const args of [["install"], ["run", "build"]]) {
      const result = spawnSync("bun", args, { cwd: app.ui, stdio: "inherit" });
      if (result.status !== 0) {
        console.error(
          `[dev] Failed to build ${app.name} UI (bun ${args.join(" ")}).\n` +
            `[dev] Build it manually: cd ${app.ui} && bun install && bun run build`,
        );
        process.exit(1);
      }
    }
  }
}

/**
 * Everything a checkout needs before the API and web servers start.
 *
 * `web` is skipped under `--no-web`, where those dependencies are never loaded.
 * App dists are built regardless: the API serves them to embedded iframes
 * whether or not the Vite dev server is running.
 */
export function prepareCheckout(repoRoot: string, opts: { web: boolean } = { web: true }): void {
  if (opts.web) installIfMissing("web", join(repoRoot, "web"));
  buildMissingAppUis(repoRoot);
}
