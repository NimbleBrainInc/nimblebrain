/**
 * `.migration-lock` — a PID file at a runtime work-dir root, held for the
 * duration of a destructive migration run. Concurrent writers refuse to start
 * instead of racing the same files; a stale lock (holder PID no longer alive)
 * is reclaimed.
 *
 * This is the reusable form of the pattern first written inline in
 * `scripts/migrate-skill-frontmatter.ts`. Every one-time migration that mutates
 * a work-dir in place acquires this lock before writing and releases it in a
 * `finally`.
 *
 * One global lock per work-dir (`{workDir}/.migration-lock`): only one
 * migration of any kind runs at a time, since two different migrations editing
 * the same tree would race just as readily as two copies of the same one. The
 * `name` identifies the holder in the refusal message so the operator knows
 * which migration is already running.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_FILENAME = ".migration-lock";

/** A held migration lock. Call `release()` when the destructive run finishes. */
export interface MigrationLock {
  /** Absolute path to the lock file. */
  readonly path: string;
  /** Remove the lock file. Best-effort; safe to call more than once. */
  release(): void;
}

/** Is `pid` a live process this user can signal? */
function pidAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** What a parsed lock file holds — its writer's PID and migration name. */
interface LockHolder {
  pid: number;
  name: string;
}

/**
 * Lock file format: PID on line 1 (parseable by the original
 * `Number(readFileSync(...).trim())` reader), migration name on line 2.
 */
function readHolder(lockPath: string): LockHolder | null {
  try {
    const lines = readFileSync(lockPath, "utf-8").split("\n");
    const pid = Number((lines[0] ?? "").trim());
    if (!pid) return null;
    return { pid, name: (lines[1] ?? "").trim() || "unknown migration" };
  } catch {
    return null;
  }
}

/**
 * Acquire the work-dir's migration lock for `name`, or throw if another live
 * migration holds it. A stale lock (holder gone) is reclaimed.
 */
export function acquireMigrationLock(workDir: string, name: string): MigrationLock {
  const path = join(workDir, LOCK_FILENAME);
  if (existsSync(path)) {
    const holder = readHolder(path);
    if (holder && pidAlive(holder.pid)) {
      throw new Error(
        `${LOCK_FILENAME} at ${workDir} is held by PID ${holder.pid} (${holder.name}) — ` +
          `another migration is running; refusing to start "${name}".`,
      );
    }
    // Stale lock (holder gone, or unparseable) — reclaim it.
  }
  writeFileSync(path, `${process.pid}\n${name}\n`, "utf-8");

  let released = false;
  return {
    path,
    release(): void {
      if (released) return;
      released = true;
      try {
        rmSync(path, { force: true });
      } catch {
        // Best-effort release; a stale lock is reclaimed on the next run.
      }
    },
  };
}
