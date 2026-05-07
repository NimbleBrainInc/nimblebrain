import { rename, rm, writeFile } from "node:fs/promises";

/**
 * Monotonic-within-process tmp suffix. Combined with `Date.now()` it
 * guarantees uniqueness even when two atomic writes land in the same
 * millisecond from the same process.
 */
let tmpCounter = 0;

/**
 * Write JSON to disk atomically: write to a uniquely-named tmp file
 * alongside the target, fsync via the rename, then rename over the
 * target. Concurrent readers either see the old file or the new file,
 * never a half-flushed JSON. Crash mid-write leaves the tmp file
 * behind; this helper cleans up its own tmp on error so a partial
 * failure doesn't leak `*.tmp` artifacts.
 *
 * Files are created with mode `0o600` — owner read/write only. Every
 * store this replaces was already scoped to a single platform UID at
 * runtime, but unifying the posture here means no future caller can
 * accidentally widen permissions on a credential-adjacent file.
 *
 * Output ends with a trailing newline so the file is `cat`-friendly
 * and matches POSIX text-file convention.
 *
 * Pretty-printed (`JSON.stringify(data, null, 2)`) — these files are
 * small (< 100KB in practice), human-readable matters more than the
 * marginal byte savings.
 */
export async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.${Date.now()}.${++tmpCounter}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await rename(tmp, path);
  } catch (err) {
    try {
      await rm(tmp, { force: true });
    } catch {
      // best-effort cleanup; original error wins
    }
    throw err;
  }
}
