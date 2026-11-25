import { join } from "node:path";
import { createFilesystemWorkQueue } from "../providers/queue/filesystem.ts";
import type { WorkQueue } from "../providers/queue/types.ts";

/** Where the work queue lives under the work directory: instance-level, never under a workspace. */
export const WORK_QUEUE_DIR = "queue";

/**
 * Open the runtime's work queue (ADR-0076, "Providers carry the
 * infrastructure"): one queue for every workspace's triggered work, which the
 * runtime's workers claim. The filesystem implementation is the only one; a
 * deployment that names another in configuration chooses it here.
 *
 * The filesystem queue serves one process (`multiProcess: false`) and locks its
 * directory, so a second runtime process on the same work directory fails here,
 * at boot, naming the process that holds it.
 */
export function openWorkQueue(workDir: string): WorkQueue {
  const dir = join(workDir, WORK_QUEUE_DIR);
  try {
    return createFilesystemWorkQueue({ dir });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[runtime] cannot open the work queue at ${dir}: ${reason} One runtime process serves a ` +
        "work directory.",
    );
  }
}
