/**
 * Fixture for test/integration/migration-lock.test.ts.
 *
 * Acquires the migration lock from a separate process, prints "acquired"
 * on success or the thrown error message on failure, holds the lock for
 * the requested duration, then releases.
 *
 * Usage: bun run acquire-migration-lock.ts <workDir> <holdMs> [<startAtUnixMs>]
 *
 * `startAtUnixMs` lets the test synchronize multiple subprocesses to a
 * common wall-clock barrier so they race the acquire call simultaneously.
 */

import { acquireMigrationLock } from "../../../scripts/lib/migration-lock.ts";

const workDir = process.argv[2];
const holdMs = Number(process.argv[3] ?? "0");
const startAt = process.argv[4] ? Number(process.argv[4]) : null;

if (!workDir) {
  console.error("usage: acquire-migration-lock.ts <workDir> <holdMs> [<startAtUnixMs>]");
  process.exit(2);
}

if (startAt !== null) {
  const wait = startAt - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

try {
  const release = acquireMigrationLock(workDir, "test-fixture");
  console.log("acquired");
  if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
  release();
  console.log("released");
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
