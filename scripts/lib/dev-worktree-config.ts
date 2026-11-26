import { join } from "node:path";

export const WORKDIR_NAME = ".nimblebrain-worktree";

/** Build the schema-valid config written on the first `dev:worktree` run. */
export function buildDevWorktreeSeed(worktreeRoot: string, workdir: string) {
  return {
    $schema: "https://schemas.nimblebrain.ai/config/v1/config.schema.json",
    version: "1",
    // `workDir` is relative to the config file; using the basename keeps the
    // workdir co-located with this config (matches the `.environments/*`
    // pattern). `NB_WORK_DIR` overrides at runtime regardless.
    workDir: workdir === join(worktreeRoot, WORKDIR_NAME) ? WORKDIR_NAME : workdir,
    // `models` is left unset so each slot resolves to the configured
    // provider's default (`src/model/default-model.ts`), the same model a
    // fresh install runs.
  };
}
