#!/usr/bin/env bun
/**
 * Stage 2 migration: move every user-scoped credential file from
 * `{workDir}/users/<userId>/credentials/...` to that user's personal
 * workspace at `{workDir}/workspaces/ws_user_<userId>/credentials/...`.
 *
 * Stage 1 unified personal workspaces under `personalWorkspaceIdFor`.
 * Stage 2 makes the user's personal workspace the home of their
 * personal credentials too — so OAuth tokens, refresh state, DCR client
 * blobs, etc. follow the same WorkspaceContext discipline as everything
 * else. After this migration the `users/<userId>/credentials/` subtree
 * goes away; the parent `users/<userId>/` directory stays (other
 * pre-Stage-3 user-scoped data still lives there).
 *
 * Idempotent and one-phase per file. Designed to run during a
 * maintenance window with the platform stopped.
 *
 * Per-file move:
 *  - `rename(2)` source → destination when only the source exists.
 *  - Skip (already migrated) when only the destination exists.
 *  - Skip (already migrated) when both exist with byte-identical
 *    contents — partial-rename heal from a prior crashed run.
 *  - **Refuse** (hard error, exit non-zero) when both exist with
 *    differing contents. Auto-picking would silently destroy data;
 *    operators reconcile.
 *
 * Crash-recovery: `rename(2)` is atomic, so a crash leaves the file at
 * exactly one of source / destination. The next run completes the
 * unfinished files transparently via the "only the source exists" or
 * "only the destination exists" branches above.
 *
 * Same-filesystem pre-flight: `rename(2)` fails EXDEV across mount
 * points. The script compares `st_dev` between the `users/` subtree and
 * the `workspaces/` subtree and refuses the whole batch (exit 2) when
 * they differ — better than aborting mid-stream and leaving partial
 * state for an operator to reconcile.
 *
 * Personal workspace ids resolve only through `personalWorkspaceIdFor`
 * — the migration never hand-builds `ws_user_<id>` (enforced by
 * `check:personal-workspace-id` over `src/`; verified by grep in the
 * integration test).
 *
 * Usage:
 *     bun run scripts/migrate-user-creds-to-personal-workspace.ts \
 *         [--work-dir <path>] [--dry-run|--apply]
 */

import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { personalWorkspaceIdFor } from "../src/workspace/workspace-store.ts";
import { acquireMigrationLock } from "./lib/migration-lock.ts";

interface Args {
  workDir: string;
  dryRun: boolean;
}

interface PerUserStats {
  userId: string;
  moved: number;
  skipped: number;
  conflicts: string[];
}

interface Stats {
  usersScanned: number;
  usersWithCreds: number;
  perUser: PerUserStats[];
  totalMoved: number;
  totalSkipped: number;
  totalConflicts: number;
  errors: { ctx: string; message: string }[];
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let workDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
  // Dry-run is the default; --apply is the opt-in write mode.
  let dryRun = true;
  let sawApply = false;
  let sawDryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--dry-run") {
      sawDryRun = true;
      dryRun = true;
    } else if (arg === "--apply") {
      sawApply = true;
      dryRun = false;
    } else if (arg === "--work-dir") {
      workDir = argv[++i] ?? "";
    } else if (arg?.startsWith("--work-dir=")) {
      workDir = arg.slice("--work-dir=".length);
    } else {
      console.error(`[migrate] unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  if (sawApply && sawDryRun) {
    console.error("[migrate] --apply and --dry-run are mutually exclusive");
    process.exit(2);
  }

  if (!workDir) {
    console.error("[migrate] --work-dir is required (or set NB_WORK_DIR)");
    process.exit(2);
  }
  return { workDir, dryRun };
}

function printHelp(): void {
  console.log(`
migrate-user-creds-to-personal-workspace — Stage 2 of the cross-workspace refactor

Moves every user-scoped credential file from
  users/<userId>/credentials/...
to the user's personal workspace at
  workspaces/ws_user_<userId>/credentials/...

Usage:
  bun run scripts/migrate-user-creds-to-personal-workspace.ts [options]

Options:
  --work-dir <path>   Override the work directory.
                      Defaults to $NB_WORK_DIR or ~/.nimblebrain.
  --dry-run           (default) Report planned moves without writing.
  --apply             Actually perform the moves.
  -h, --help          This message.

Run during a maintenance window with the platform stopped. Idempotent —
a second --apply run produces zero new moves. Both --dry-run and --apply
acquire the same .migration-lock as Stage 1's scripts.
`);
}

/**
 * Same-filesystem pre-flight. `rename(2)` returns EXDEV when source and
 * destination cross mount points; one user's per-file failure mid-batch
 * leaves the workdir in partial state. The cheap check up front refuses
 * the entire run and tells the operator what to do.
 *
 * Comparison: `st_dev` of the `users/` subtree against the `workspaces/`
 * subtree (or each path's nearest existing ancestor — both directories
 * may not exist yet on a workdir that's never seen creds or workspaces).
 * If either side resolves to null (e.g. the volume is unreadable) we
 * skip the check rather than false-positive — the per-file `rename` will
 * surface EXDEV the same way `migrate-conversations-to-top-level.ts`
 * does and the operator gets the same actionable signal.
 */
function preflightSameFs(usersDir: string, workspacesDir: string, workDir: string): void {
  const devOf = (path: string): number | null => {
    let cur = path;
    while (cur && !existsSync(cur)) {
      const parent = join(cur, "..");
      if (parent === cur) return null;
      cur = parent;
    }
    if (!cur) return null;
    try {
      return statSync(cur).dev;
    } catch {
      return null;
    }
  };
  // Test-only override: integration tests can't portably stage two
  // filesystems, so they set NB_MIGRATE_FORCE_EXDEV=1 to exercise the
  // error-path code. Reading the env var in one place keeps the
  // exercise as close as possible to a real EXDEV scenario.
  const forceExdev = process.env.NB_MIGRATE_FORCE_EXDEV === "1";
  const srcDev = forceExdev ? 1 : devOf(usersDir);
  const dstDev = forceExdev ? 2 : devOf(workspacesDir);
  if (srcDev === null || dstDev === null) return;
  if (srcDev !== dstDev) {
    console.error(
      `[migrate] [FATAL] source and destination are on different filesystems ` +
        `(users/ on dev=${srcDev}, workspaces/ on dev=${dstDev}). ` +
        `\`rename(2)\` cannot cross mount points — every move would fail EXDEV. ` +
        `Either consolidate ${workDir}'s subtree onto one mount, or run a copy-then-delete ` +
        `migration (this script is rename-only by design for atomicity).`,
    );
    process.exit(2);
  }
}

/**
 * Recursively walk a directory and yield every file path. Returns paths
 * relative to `root` so we can map source-relative → destination-relative
 * in a single pass. Symlinks are NOT followed: a credential subtree that
 * contains symlinks is operator-managed and we don't want to leak the
 * link target into the workspace tree.
 */
async function listFilesRelative(root: string): Promise<string[]> {
  const out: string[] = [];
  if (!existsSync(root)) return out;

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile()) {
        out.push(relative(root, abs));
      }
      // Symlinks / sockets / etc. are intentionally skipped — see header.
    }
  }

  await visit(root);
  return out;
}

/**
 * Byte-level content comparison. Both sides exist; equal bytes mean a
 * prior run already moved this file (partial-rename heal). Differing
 * bytes mean two divergent histories — refuse to merge automatically.
 *
 * Read-into-memory is fine here: credential files are small (a few KB
 * for tokens, < 100 KB for DCR client blobs). If a future credential
 * type lands > 1 MB we can switch to a streaming hash; today, simple
 * wins.
 */
async function filesIdentical(a: string, b: string): Promise<boolean> {
  const [bufA, bufB] = await Promise.all([readFile(a), readFile(b)]);
  if (bufA.length !== bufB.length) return false;
  return bufA.equals(bufB);
}

/**
 * Per-user move pass. Returns the per-user stats. Throws only on
 * unexpected fs errors — expected conditions (already-migrated, conflict)
 * are returned in the stats so the caller can decide overall exit code.
 */
async function migrateUser(
  userId: string,
  srcCredsDir: string,
  dstCredsDir: string,
  dryRun: boolean,
): Promise<PerUserStats> {
  const stats: PerUserStats = { userId, moved: 0, skipped: 0, conflicts: [] };

  const srcFiles = await listFilesRelative(srcCredsDir);
  if (srcFiles.length === 0) {
    // Nothing left at source — either never migrated (no creds) or fully
    // migrated by a prior run. Either way, this user's pass is a no-op.
    // The empty-source-dir cleanup is handled by the caller after the
    // per-file loop returns.
    return stats;
  }

  for (const rel of srcFiles) {
    const srcPath = join(srcCredsDir, rel);
    const dstPath = join(dstCredsDir, rel);

    if (existsSync(dstPath)) {
      // Both sides exist. Distinguish heal (identical) from conflict.
      const identical = await filesIdentical(srcPath, dstPath);
      if (identical) {
        // Heal path: the destination already has the same bytes, so the
        // source is stale. Remove it (or report in dry-run) so the
        // workdir converges.
        if (!dryRun) {
          // Remove the stale source file. The destination is canonical
          // (a prior crashed run already migrated this file); the
          // duplicate source is dead state.
          await unlink(srcPath);
        }
        stats.skipped++;
        console.error(
          `[migrate]   ${dryRun ? "[dry-run] would skip" : "skip"} ${userId}/${rel} (already migrated; stale source ${dryRun ? "would be" : ""} removed)`,
        );
        continue;
      }
      // Different bytes → operator must reconcile.
      stats.conflicts.push(rel);
      console.error(
        `[migrate]   [CONFLICT] ${userId}/${rel}: both source and destination exist with different contents`,
      );
      console.error(`[migrate]     source: ${srcPath}`);
      console.error(`[migrate]     dest:   ${dstPath}`);
      continue;
    }

    // Only source exists — this is the normal move case.
    if (dryRun) {
      console.error(
        `[migrate]   [dry-run] would move ${userId}/${rel} → workspaces/${personalWorkspaceIdFor(userId)}/credentials/${rel}`,
      );
      stats.moved++;
      continue;
    }

    // Ensure the destination directory tree exists. Credential files
    // can sit under arbitrary subpaths (`mcp-oauth/<server>/tokens.json`,
    // etc.), so we need the parent dir created before `rename(2)`.
    const dstParent = dirname(dstPath);
    await mkdir(dstParent, { recursive: true, mode: 0o700 });

    // The actual move. `rename(2)` is atomic on a single filesystem,
    // which the preflight has already verified.
    await rename(srcPath, dstPath);
    stats.moved++;
    console.error(`[migrate]   moved ${userId}/${rel}`);
  }

  return stats;
}

/**
 * Recursively remove empty directories under `root`, stopping at `root`
 * itself (which is also removed if it ends up empty). Used to clean up
 * the now-empty `users/<userId>/credentials/...` tree after a successful
 * --apply run. Idempotent — `rmdir` on a non-empty dir errors with
 * ENOTEMPTY and we surface it; on a non-existent dir we no-op.
 */
async function removeEmptyDirsBottomUp(root: string): Promise<void> {
  if (!existsSync(root)) return;

  async function visit(dir: string): Promise<boolean> {
    const entries = await readdir(dir, { withFileTypes: true });
    let allEmpty = true;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subEmpty = await visit(join(dir, entry.name));
        if (!subEmpty) allEmpty = false;
      } else {
        allEmpty = false;
      }
    }
    if (allEmpty) {
      try {
        await rmdir(dir);
      } catch (err) {
        // Another process raced us, or it became non-empty between the
        // readdir and the rmdir. Either way, leave it for the operator.
        if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw err;
        return false;
      }
      return true;
    }
    return false;
  }

  await visit(root);
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(
    `[migrate] workDir=${args.workDir}${args.dryRun ? " (dry-run)" : " (apply)"}`,
  );

  const usersDir = join(args.workDir, "users");
  const workspacesDir = join(args.workDir, "workspaces");

  if (!existsSync(args.workDir)) {
    console.error(`[migrate] workDir does not exist: ${args.workDir}`);
    process.exit(1);
  }

  // Lock both for --dry-run and --apply. Stage 1 lesson: even a
  // read-only dry-run racing with a real --apply produces confusing
  // output and risks accidentally trusting stale plans.
  acquireMigrationLock(args.workDir, "migrate-user-creds-to-personal-workspace");

  preflightSameFs(usersDir, workspacesDir, args.workDir);

  if (!existsSync(usersDir)) {
    console.error(`[migrate] no users dir at ${usersDir} — nothing to do`);
    return;
  }

  const stats: Stats = {
    usersScanned: 0,
    usersWithCreds: 0,
    perUser: [],
    totalMoved: 0,
    totalSkipped: 0,
    totalConflicts: 0,
    errors: [],
  };

  const userEntries = await readdir(usersDir, { withFileTypes: true });
  for (const entry of userEntries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    stats.usersScanned++;

    const userId = entry.name;
    const srcCredsDir = join(usersDir, userId, "credentials");
    if (!existsSync(srcCredsDir)) continue;
    stats.usersWithCreds++;

    const wsId = personalWorkspaceIdFor(userId);
    const dstCredsDir = join(workspacesDir, wsId, "credentials");

    console.error(`[migrate] user ${userId} → ${wsId}`);

    try {
      const perUser = await migrateUser(userId, srcCredsDir, dstCredsDir, args.dryRun);
      stats.perUser.push(perUser);
      stats.totalMoved += perUser.moved;
      stats.totalSkipped += perUser.skipped;
      stats.totalConflicts += perUser.conflicts.length;

      // Clean up the now-empty source tree under --apply. Conflicts left
      // files at the source, so this is a no-op when there's anything
      // left behind — `rmdir` errors on non-empty dirs and our helper
      // tolerates that.
      if (!args.dryRun && perUser.conflicts.length === 0) {
        await removeEmptyDirsBottomUp(srcCredsDir);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[migrate] ERROR for user ${userId}: ${message}`);
      stats.errors.push({ ctx: userId, message });
    }
  }

  console.error("");
  console.error(`[migrate] summary${args.dryRun ? " (dry-run)" : ""}:`);
  console.error(`[migrate]   users scanned:                 ${stats.usersScanned}`);
  console.error(`[migrate]   users with credentials/ dir:   ${stats.usersWithCreds}`);
  for (const u of stats.perUser) {
    console.error(
      `[migrate]     ${u.userId}: moved=${u.moved} skipped=${u.skipped} conflicts=${u.conflicts.length}`,
    );
  }
  console.error(`[migrate]   total moved:                   ${stats.totalMoved}`);
  console.error(`[migrate]   total skipped (already migrated): ${stats.totalSkipped}`);
  console.error(`[migrate]   total conflicts:               ${stats.totalConflicts}`);
  console.error(`[migrate]   errors:                        ${stats.errors.length}`);

  if (stats.totalConflicts > 0) {
    console.error(
      `[migrate] [FATAL] ${stats.totalConflicts} conflict(s) require operator reconciliation. ` +
        `Neither side was modified. Resolve each path above manually, then re-run.`,
    );
    process.exit(2);
  }
  if (stats.errors.length > 0) {
    for (const e of stats.errors) console.error(`[migrate]     [error] ${e.ctx}: ${e.message}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
