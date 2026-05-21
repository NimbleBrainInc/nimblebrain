/**
 * Concurrent-run lock for migration scripts.
 *
 * Two operators racing on the same `workDir` could corrupt the
 * rename / unlink sequences (Stage 1's two migration scripts both
 * do non-idempotent fs work mid-stream — partial state is recoverable
 * on rerun, but interleaving two runs is not). A simple `.migration-lock`
 * PID file closes the gap.
 *
 * Lock file shape: `{workDir}/.migration-lock` containing
 * `{ pid: number, startedAt: ISO 8601 string, script: string }`.
 *
 * Acquire semantics (atomic via `O_EXCL` open):
 *  - Try `writeFileSync(..., flag: "wx")` — succeeds iff no file exists.
 *    No check-then-write window: kernel guarantees one winner.
 *  - On `EEXIST`, inspect the existing lock:
 *      - Live PID → throw with the holder's details.
 *      - Dead PID → log + unlink + retry the exclusive write.
 *      - Corrupt JSON → log + unlink + retry the exclusive write.
 *    Bounded by `MAX_ACQUIRE_ATTEMPTS` to prevent pathological loops if
 *    multiple racers contend for the takeover.
 *
 * Release: unlink the lock file. Wired into `process.on("exit"|"SIGINT"|"SIGTERM")`
 * so a Ctrl-C or normal exit clears it. A `kill -9` leaves a stale lock;
 * the next run detects the dead PID and recovers.
 *
 * Dry-run: still takes the lock — even a dry-run reading state
 * concurrently with a real migration could surface inconsistent results.
 * The cost (a 5 ms write) is negligible.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_FILENAME = ".migration-lock";
const MAX_ACQUIRE_ATTEMPTS = 3;

interface LockFile {
  pid: number;
  startedAt: string;
  script: string;
}

/** Returns true if the given PID is alive in this process's pid namespace. */
function isPidAlive(pid: number): boolean {
  try {
    // `kill(pid, 0)` is the POSIX "does this process exist + can I signal it"
    // check. Throws ESRCH if the process is gone, EPERM if it exists but
    // we don't have permission (still alive, just not ours — treat as
    // alive to be safe). Anything else is a real error; let it bubble.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    throw err;
  }
}

/**
 * Atomic create-if-absent. Returns true on success, false on EEXIST.
 * Other errors propagate.
 */
function tryWriteLockExclusive(lockPath: string, lock: LockFile): boolean {
  try {
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/**
 * Acquire the migration lock. Throws if another live process holds it.
 * Returns a `release()` function the caller should call on clean exit
 * (also wired into process-exit signals automatically).
 */
export function acquireMigrationLock(workDir: string, script: string): () => void {
  const lockPath = join(workDir, LOCK_FILENAME);
  const lock: LockFile = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    script,
  };

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    if (tryWriteLockExclusive(lockPath, lock)) break;

    // EEXIST — inspect the holder.
    let existing: LockFile | null = null;
    try {
      existing = JSON.parse(readFileSync(lockPath, "utf-8")) as LockFile;
    } catch {
      // Corrupt JSON — fall through to takeover.
    }

    if (existing && typeof existing.pid === "number" && isPidAlive(existing.pid)) {
      throw new Error(
        `Another migration is already running (script=${existing.script}, pid=${existing.pid}, startedAt=${existing.startedAt}). ` +
          "If you're certain no other migration is in flight, remove " +
          `${lockPath} manually and try again.`,
      );
    }

    if (existing) {
      console.warn(
        `[migrate] stale lock at ${lockPath} (script=${existing.script}, pid=${existing.pid}, dead) — taking over.`,
      );
    } else {
      console.warn(`[migrate] corrupt lock at ${lockPath} — taking over.`);
    }

    try {
      unlinkSync(lockPath);
    } catch {
      // Concurrent takeover removed it first; next iteration re-evaluates.
    }

    if (attempt === MAX_ACQUIRE_ATTEMPTS - 1) {
      throw new Error(
        `Could not acquire migration lock at ${lockPath} after ${MAX_ACQUIRE_ATTEMPTS} attempts — concurrent takeover contention.`,
      );
    }
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      // Only unlink if it's still OUR lock — protects against the
      // pathological case where a third process took over our lock
      // during execution (shouldn't happen with the alive-PID check,
      // but the cost of the read is trivial).
      const cur = JSON.parse(readFileSync(lockPath, "utf-8")) as LockFile;
      if (cur.pid === process.pid) unlinkSync(lockPath);
    } catch {
      // Already gone or unreadable — nothing to do.
    }
  };

  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(143);
  });

  return release;
}
