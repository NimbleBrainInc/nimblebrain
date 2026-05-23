/**
 * Exercises scripts/lib/migration-lock.ts.
 *
 * The atomic invariant: `writeFileSync(..., flag: "wx")` guarantees at
 * most one process creates the lock file. EEXIST is the only path under
 * contention; the takeover branch (dead PID / corrupt JSON) goes through
 * unlink + retry so a third racer cannot wedge in.
 *
 * In-process tests cover the EEXIST branches deterministically. The
 * concurrent-subprocess test proves the invariant under real OS-level
 * race conditions with a wall-clock barrier so all subprocesses hit
 * the kernel `open(O_EXCL)` within microseconds of each other.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { acquireMigrationLock } from "../../scripts/lib/migration-lock.ts";

const LOCK_FILENAME = ".migration-lock";

// 2^31 - 1: above any platform's max PID, so kill(0) reliably returns
// ESRCH. (PIDs 0/1 are special on POSIX; avoid both.)
const DEFINITELY_DEAD_PID = 2147483647;

const FIXTURE = join(
  import.meta.dirname ?? __dirname,
  "fixtures",
  "acquire-migration-lock.ts",
);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-migration-lock-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function lockPath(): string {
  return join(workDir, LOCK_FILENAME);
}

function readLock(): { pid: number; startedAt: string; script: string } {
  return JSON.parse(readFileSync(lockPath(), "utf-8"));
}

describe("acquireMigrationLock", () => {
  test("clean acquire writes lock with our pid; release deletes it", () => {
    expect(existsSync(lockPath())).toBe(false);

    const release = acquireMigrationLock(workDir, "test-script");

    expect(existsSync(lockPath())).toBe(true);
    const lock = readLock();
    expect(lock.pid).toBe(process.pid);
    expect(lock.script).toBe("test-script");

    release();
    expect(existsSync(lockPath())).toBe(false);
  });

  test("rejects acquire when lock holds a live pid (atomic invariant)", () => {
    // Pre-seed the lock with a definitely-live pid (our own). The wx-write
    // hits EEXIST, the read+isPidAlive check confirms the holder is live,
    // and acquire throws without touching the file.
    writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        script: "other-script",
      }),
    );

    expect(() => acquireMigrationLock(workDir, "test-script")).toThrow(
      /Another migration is already running/,
    );

    // Original lock unchanged — proves no clobber.
    expect(readLock().script).toBe("other-script");
  });

  test("takes over a stale (dead-pid) lock", () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({
        pid: DEFINITELY_DEAD_PID,
        startedAt: new Date().toISOString(),
        script: "stale-script",
      }),
    );

    const release = acquireMigrationLock(workDir, "test-script");

    const lock = readLock();
    expect(lock.pid).toBe(process.pid);
    expect(lock.script).toBe("test-script");

    release();
    expect(existsSync(lockPath())).toBe(false);
  });

  test("takes over a corrupt-json lock", () => {
    writeFileSync(lockPath(), "{ not valid json");

    const release = acquireMigrationLock(workDir, "test-script");

    expect(readLock().pid).toBe(process.pid);

    release();
  });

  test("release is idempotent", () => {
    const release = acquireMigrationLock(workDir, "test-script");
    release();
    release(); // No throw, no error.
    expect(existsSync(lockPath())).toBe(false);
  });

  test("acquire after release succeeds (the round-9 audit's named flow)", () => {
    const releaseA = acquireMigrationLock(workDir, "script-a");
    expect(readLock().script).toBe("script-a");
    releaseA();

    const releaseB = acquireMigrationLock(workDir, "script-b");
    expect(readLock().script).toBe("script-b");
    releaseB();

    expect(existsSync(lockPath())).toBe(false);
  });

  test("concurrent subprocesses: exactly one acquires, rest are rejected", async () => {
    // Eight subprocesses synchronized to a common wall-clock barrier so
    // their acquireMigrationLock calls overlap. The kernel's O_EXCL means
    // exactly one writeFileSync(wx) succeeds; the seven losers see the
    // winner's live pid and throw.
    const N = 8;
    const HOLD_MS = 400; // Long enough to span all racers' acquire attempts.
    const BARRIER_MS = 300; // Subprocess startup budget before everyone races.

    const startAt = Date.now() + BARRIER_MS;
    const procs = Array.from({ length: N }, () =>
      Bun.spawn({
        cmd: ["bun", "run", FIXTURE, workDir, String(HOLD_MS), String(startAt)],
        stdout: "pipe",
        stderr: "pipe",
      }),
    );

    const outputs = await Promise.all(
      procs.map(async (p) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(p.stdout).text(),
          new Response(p.stderr).text(),
          p.exited,
        ]);
        return { stdout, stderr, exitCode };
      }),
    );

    const acquired = outputs.filter((o) => o.stdout.includes("acquired"));
    const rejected = outputs.filter(
      (o) =>
        o.exitCode === 1 && o.stderr.includes("Another migration is already running"),
    );

    expect(acquired).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);
    expect(acquired[0]?.exitCode).toBe(0);
    expect(acquired[0]?.stdout).toContain("released");

    // Winner cleaned up after itself.
    expect(existsSync(lockPath())).toBe(false);
  }, 10_000);
});
