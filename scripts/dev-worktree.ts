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
 * unlock real LLM calls. Without them, everything but model invocation
 * still works — uploads, MCP resources, tool calls, conversation log.
 *
 * Reset state:  `rm -rf .nimblebrain-worktree && bun run dev:worktree`
 * Share state across worktrees:  `NB_WORK_DIR=/abs/path bun run dev:worktree`
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Anchor the worktree root from the script's location, not `process.cwd()`,
// so `bun run scripts/dev-worktree.ts` from a subdirectory still resolves
// the right place. The script lives at `<worktree>/scripts/dev-worktree.ts`,
// so the parent of its containing directory is the worktree root.
const WORKTREE_ROOT = dirname(import.meta.dir);
const WORKDIR_NAME = ".nimblebrain-worktree";
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
  const seed = {
    $schema: "https://schemas.nimblebrain.ai/v1/nimblebrain-config.schema.json",
    version: "1",
    // `workDir` is relative to the config file; using the basename keeps the
    // workdir co-located with this config (matches the `.environments/*`
    // pattern). `NB_WORK_DIR` overrides at runtime regardless.
    workDir: WORKDIR === join(WORKTREE_ROOT, WORKDIR_NAME) ? WORKDIR_NAME : WORKDIR,
    bundles: [],
    // Defaults mirror the documented values in `AGENTS.md` § Defaults so
    // dev:worktree starts in the same shape the rest of the platform's dev
    // environments use.
    models: {
      default: "anthropic:claude-sonnet-4-6",
      fast: "anthropic:claude-haiku-4-5-20251001",
      reasoning: "anthropic:claude-opus-4-6",
    },
  };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(seed, null, 2)}\n`);
  console.log(`[dev:worktree] Seeded ${CONFIG_PATH}`);
}

seedConfigIfMissing();

console.log("[dev:worktree] Starting");
console.log(`[dev:worktree]   Worktree: ${WORKTREE_ROOT}`);
console.log(`[dev:worktree]   Workdir:  ${WORKDIR}`);
console.log(`[dev:worktree]   API:      http://localhost:${API_PORT}`);
console.log(`[dev:worktree]   Web:      http://localhost:${WEB_PORT}`);
console.log("[dev:worktree]   Auth:     none (dev mode)");

const child = spawn(
  "bun",
  ["run", "src/cli/index.ts", "dev", "--port", API_PORT, "--config", CONFIG_PATH],
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
