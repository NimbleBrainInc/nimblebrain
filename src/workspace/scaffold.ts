import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Subdirectories created inside every workspace. */
export const WORKSPACE_DIRS = ["data", "credentials", "conversations", "skills", "files"] as const;

/**
 * Scaffold the directory structure for a workspace.
 * Creates required subdirectories with `.gitkeep` sentinel files.
 * Idempotent — safe to call on an already-scaffolded workspace.
 *
 * The `credentials/` subdirectory is created with `0o700` so secrets stored
 * there are readable only by the owning user. Other subdirectories use the
 * default umask-derived mode (typically `0o755`) since they hold non-secret
 * bundle state, skills, and conversations.
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
