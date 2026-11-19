#!/usr/bin/env bun
/**
 * Run the platform from a worktree against an isolated workdir.
 *
 * Use case: smoke-test or QA against a feature branch without colliding
 * with a primary `~/.nimblebrain` dev or another worktree's state. Runs
 * in dev mode (no `instance.json` → no auth gate), so it's suitable for
 * Chrome DevTools-driven E2E against `/v1/*` endpoints with no login
 * dance.
 *
 * Convention (per worktree root):
 *   - Workdir: `<cwd>/.nimblebrain-worktree/`
 *   - Config:  `<cwd>/.nimblebrain-worktree/nimblebrain.json` (auto-seeded on first run)
 *   - Ports:   API 27271, Web 27270 (override via `NB_API_PORT` / `NB_WEB_PORT`)
 *   - Auth:    none (dev mode — no `instance.json`)
 *
 * Set `ANTHROPIC_API_KEY` (or other provider keys) in your shell to
 * unlock real LLM calls. As a convenience, `scripts/dev.ts` also loads
 * `<worktree>/.env` if present, otherwise the main repo's `.env`
 * (discovered via `git rev-parse --git-common-dir`). Shell-exported
 * values always win over the file. The origins (`NB_PUBLIC_ORIGIN`,
 * `ALLOWED_ORIGINS`, `NB_WEB_URL`) never come from the file: they are
 * derived from this run's ports unless exported in the shell, so a `.env`
 * written for the default dev ports cannot send an OAuth callback to
 * another server. Both scripts run
 * under `bun --no-env-file` so that load is the only one. Without any keys
 * set, everything but model invocation still works — uploads, MCP
 * resources, tool calls, conversation log.
 *
 * Reset state:  `rm -rf .nimblebrain-worktree && bun run dev:worktree`
 * Share state across worktrees:  `NB_WORK_DIR=/abs/path bun run dev:worktree`
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDevOrigins } from "./lib/dev-env.ts";
import { installIfMissing } from "./lib/dev-prepare.ts";
import { buildDevWorktreeSeed, WORKDIR_NAME } from "./lib/dev-worktree-config.ts";

// Anchor the worktree root from the script's location, not `process.cwd()`,
// so `bun run scripts/dev-worktree.ts` from a subdirectory still resolves
// the right place. The script lives at `<worktree>/scripts/dev-worktree.ts`,
// so the parent of its containing directory is the worktree root.
const WORKTREE_ROOT = dirname(import.meta.dir);
// `||` (not `??`) so an accidentally-exported empty `NB_WORK_DIR=""` from a
// misconfigured shell or direnv doesn't slip through and produce nonsense
// paths. Same for the port vars below.
const WORKDIR = process.env.NB_WORK_DIR || join(WORKTREE_ROOT, WORKDIR_NAME);
const CONFIG_PATH = join(WORKDIR, "nimblebrain.json");
const API_PORT = process.env.NB_API_PORT || "27271";
const WEB_PORT = process.env.NB_WEB_PORT || "27270";

function seedConfigIfMissing(): void {
  if (existsSync(CONFIG_PATH)) return;
  mkdirSync(WORKDIR, { recursive: true });
  const seed = buildDevWorktreeSeed(WORKTREE_ROOT, WORKDIR);
  writeFileSync(CONFIG_PATH, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(`[dev:worktree] Seeded ${CONFIG_PATH}`);
}

seedConfigIfMissing();

// What `scripts/dev.ts` will resolve: `.env` is loaded there, and under
// `--no-env-file` nothing in this process came from a file, so every origin
// set here is a shell export and the rest are derived from the ports.
const origins = resolveDevOrigins(process.env, [], { api: API_PORT, web: WEB_PORT });

// Root ONLY. `scripts/dev.ts` imports from `src/`, so it cannot install the
// deps it needs to be loaded — that has to happen before it is spawned. Web
// deps and app UI builds live in `scripts/lib/dev-prepare.ts`, which dev.ts
// runs, so every launcher gets them and not just this one.
installIfMissing("root", WORKTREE_ROOT, "[dev:worktree]");

console.log("[dev:worktree] Starting");
console.log(`[dev:worktree]   Worktree: ${WORKTREE_ROOT}`);
console.log(`[dev:worktree]   Workdir:  ${WORKDIR}`);
console.log(`[dev:worktree]   API:      http://localhost:${API_PORT}`);
console.log(`[dev:worktree]   Web:      http://localhost:${WEB_PORT}`);
console.log("[dev:worktree]   Auth:     none (dev mode)");
console.log(`[dev:worktree]   Origin:   ${origins.NB_PUBLIC_ORIGIN} (NB_PUBLIC_ORIGIN)`);
console.log(`[dev:worktree]   CORS:     ${origins.ALLOWED_ORIGINS} (ALLOWED_ORIGINS)`);

// Delegate to the shared dev orchestrator (serve API + Vite web). The runtime
// binary is serve-only — it no longer has a `dev` subcommand — so worktree dev
// goes through `scripts/dev.ts`, the same launcher `bun run dev` uses, with the
// worktree's ports/workdir threaded via env below.
const child = spawn(
  "bun",
  ["--no-env-file", "scripts/dev.ts", "--port", API_PORT, "--config", CONFIG_PATH],
  {
    stdio: "inherit",
    cwd: WORKTREE_ROOT,
    env: {
      ...process.env,
      NB_API_PORT: API_PORT,
      NB_WEB_PORT: WEB_PORT,
      NB_WORK_DIR: WORKDIR,
    },
  },
);

child.on("error", (err) => {
  console.error(`[dev:worktree] Failed to spawn bun: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code) => process.exit(code ?? 0));
