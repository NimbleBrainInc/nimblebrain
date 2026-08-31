import { join } from "node:path";

const WORKDIR_NAME = ".nimblebrain-worktree";

/** Build the schema-valid config written on the first `dev:worktree` run. */
export function buildDevWorktreeSeed(worktreeRoot: string, workdir: string) {
  return {
    $schema: "https://schemas.nimblebrain.ai/v1/nimblebrain-config.schema.json",
    version: "1",
    // `workDir` is relative to the config file; using the basename keeps the
    // workdir co-located with this config (matches the `.environments/*`
    // pattern). `NB_WORK_DIR` overrides at runtime regardless.
    workDir: workdir === join(worktreeRoot, WORKDIR_NAME) ? WORKDIR_NAME : workdir,
    bundles: [],
    // Defaults mirror the documented values in `AGENTS.md` § Defaults so
    // dev:worktree starts in the same shape the rest of the platform's dev
    // environments use.
    models: {
      default: "anthropic:claude-sonnet-4-6",
      fast: "anthropic:claude-haiku-4-5-20251001",
    },
  };
}
