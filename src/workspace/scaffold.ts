import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Subdirectories created inside every workspace.
 *
 * Not every workspace subtree appears here. One whose store creates its own
 * directory on first write is deliberately absent, because pre-scaffolding it
 * would leave an empty dir in every workspace that never uses the feature:
 * `conversations/` (resolves under `<wsId>/conversations/<ownerId>/`, one log
 * per conversation), `notifications/` (one JSONL per day, written when a
 * connector first emits) and `automations/` (under `<ownerId>/`, one file per
 * automation) are all that shape, as is the per-owner partition beneath the
 * `files/` dir this DOES create. No live code writes a flat top-level
 * `{workDir}/conversations/` dir.
 *
 * A store creating its own subtree stays correct; what it may not do is create
 * the workspace ROOT. `assertWorkspaceRootExists` (`./context.ts`) holds that
 * line, and `create` calling this function is one of the two sites allowed
 * past it.
 */
export const WORKSPACE_DIRS = ["data", "credentials", "skills", "files"] as const;

/**
 * Scaffold the directory structure for a workspace.
 * Creates required subdirectories with `.gitkeep` sentinel files.
 * Idempotent — safe to call on an already-scaffolded workspace.
 *
 * The `credentials/` subdirectory is created with `0o700` so secrets stored
 * there are readable only by the owning user. Other subdirectories use the
 * default umask-derived mode (typically `0o755`) since they hold non-secret
 * connector state, skills, and conversations.
 */
export async function scaffoldWorkspace(workspacePath: string): Promise<void> {
  await Promise.all(
    WORKSPACE_DIRS.map(async (dir) => {
      const dirPath = join(workspacePath, dir);
      if (dir === "credentials") {
        await mkdir(dirPath, { recursive: true, mode: 0o700 });
      } else {
        await mkdir(dirPath, { recursive: true });
      }
      await writeFile(join(dirPath, ".gitkeep"), "", { flag: "wx" }).catch(
        (err: NodeJS.ErrnoException) => {
          // File already exists — idempotent
          if (err.code !== "EEXIST") throw err;
        },
      );
    }),
  );
}
