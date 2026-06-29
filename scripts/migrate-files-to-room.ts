#!/usr/bin/env bun

/**
 * One-time migration: identity-owned file store → the workspace-owned layout.
 *
 * The identity store at `{workDir}/users/<userId>/files/` predates the
 * workspace-owned layout, where a file lives under the workspace it belongs to
 * with the owner as a privacy sub-partition (see `src/files/paths.ts` and
 * `research/SPEC-permission-boundaries.md` §2.3):
 *
 *   workspaces/<wsId>/files/<ownerId>/   a member's files (private by default)
 *
 * Files carry no workspace provenance (the identity store never recorded one),
 * so each user's files move to THEIR personal workspace — the safe default:
 *
 *   users/<userId>/files/*  →  workspaces/ws_user_<userId>/files/<userId>/*
 *
 * It's a pure move of every entry in the user's files dir (registry.jsonl, blob
 * files, and `.extracted.json` sidecars). The store backfills each row's
 * `ownerId` + `workspaceId` from the destination path on read (`parseFilePath`),
 * so no registry rewrite is needed.
 *
 * Usage:
 *   bun run migrate:files-to-room                  # dry-run (default)
 *   bun run migrate:files-to-room --write          # apply the moves
 *   bun run migrate:files-to-room --work-dir /abs  # target a work-dir
 *
 * Safe by default: a dry-run prints the planned moves, writes nothing, and
 * exits 0. `--write` (or `--apply`) performs the moves under the work-dir's
 * `.migration-lock`. Idempotent: a destination that already exists is treated
 * as already-migrated (the stale identity source is removed), so a re-run after
 * a crash or a partial run reports zero moves.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { workspaceFilesDir } from "../src/files/paths.ts";
import { personalWorkspaceIdFor } from "../src/workspace/workspace-store.ts";
import { acquireMigrationLock } from "./lib/migration-lock.ts";

const MIGRATION_NAME = "files-to-room";

/** The per-(wsId, ownerId) append-log of file metadata — merged, never moved. */
const REGISTRY_FILENAME = "registry.jsonl";

/** A single file's planned (dry-run) or performed (write) disposition. */
interface MovePlan {
  userId: string;
  from: string;
  to: string;
  /**
   * `move` — relocate to a fresh dest; `existing` — a content-addressed blob is
   * already at the dest, drop the stale source; `merge` — append the source
   * registry's rows onto an existing dest registry (it is an append-log, so the
   * two can hold disjoint entries).
   */
  action: "move" | "existing" | "merge";
}

export interface MigrationSummary {
  /** Files relocated to a fresh destination (or that would be, in dry-run). */
  moved: number;
  /** Blobs whose destination already existed — treated as already-migrated. */
  skippedExisting: number;
  /** Registries appended onto an existing destination registry. */
  merged: number;
  /** Distinct users whose files dir held at least one entry to migrate. */
  users: number;
  /** The per-file dispositions, for printing / assertions. */
  plans: MovePlan[];
}

function emptySummary(): MigrationSummary {
  return { moved: 0, skippedExisting: 0, merged: 0, users: 0, plans: [] };
}

/**
 * Plan (and, when `write`, perform) the move of every file under
 * `{workDir}/users/<userId>/files/` into that user's personal-workspace files
 * partition. Pure read in dry-run; acquires the work-dir migration lock for the
 * write path. Same-filesystem `renameSync` per entry — atomic, and never reads
 * the (potentially large) blob bytes into memory.
 */
export function migrateFilesToRoom(workDir: string, opts: { write: boolean }): MigrationSummary {
  const summary = emptySummary();
  const usersDir = join(workDir, "users");

  let userIds: string[];
  try {
    userIds = readdirSync(usersDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // No users dir — nothing to migrate (fresh or already-migrated install).
    return summary;
  }

  const lock = opts.write ? acquireMigrationLock(workDir, MIGRATION_NAME) : null;
  try {
    for (const userId of userIds) {
      const srcDir = join(usersDir, userId, "files");

      let names: string[];
      try {
        names = readdirSync(srcDir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name);
      } catch {
        // This user has no files dir — nothing to move.
        continue;
      }
      if (names.length === 0) continue;

      const destDir = workspaceFilesDir(workDir, personalWorkspaceIdFor(userId), userId);
      summary.users++;

      for (const name of names) {
        const srcFile = join(srcDir, name);
        const destFile = join(destDir, name);

        // registry.jsonl is an append-log, not content-addressed: a fresh upload
        // between deploy and migration creates a dest registry holding only the
        // new row, while the source registry holds the pre-existing rows. Merge
        // by appending the source rows (readRegistry dedupes by id, last-write
        // wins) — never move-or-drop it, which would orphan the pre-existing
        // files (their blobs move, but their registry entries are lost).
        if (name === REGISTRY_FILENAME && existsSync(destFile)) {
          summary.plans.push({ userId, from: srcFile, to: destFile, action: "merge" });
          if (opts.write) {
            appendFileSync(destFile, readFileSync(srcFile));
            unlinkSync(srcFile);
          }
          summary.merged++;
          continue;
        }

        if (existsSync(destFile)) {
          // A content-addressed blob already at the dest (a prior partial run, or
          // a re-run). The dest is canonical; drop the stale source.
          summary.skippedExisting++;
          summary.plans.push({ userId, from: srcFile, to: destFile, action: "existing" });
          if (opts.write) unlinkSync(srcFile);
          continue;
        }

        summary.plans.push({ userId, from: srcFile, to: destFile, action: "move" });
        if (opts.write) {
          mkdirSync(destDir, { recursive: true });
          renameSync(srcFile, destFile);
        }
        summary.moved++;
      }
    }
  } finally {
    lock?.release();
  }

  return summary;
}

function resolveWorkDir(args: string[]): string {
  const eq = args.find((a) => a.startsWith("--work-dir="));
  if (eq) return eq.slice("--work-dir=".length);
  const flagIdx = args.indexOf("--work-dir");
  if (flagIdx !== -1 && args[flagIdx + 1]) return args[flagIdx + 1] as string;
  return process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes("--write") || args.includes("--apply");
  const workDir = resolveWorkDir(args);

  const summary = migrateFilesToRoom(workDir, { write });

  const verb = write ? "Moved" : "Would move";
  for (const plan of summary.plans) {
    const room = `ws_user_${plan.userId} · ${plan.userId}`;
    if (plan.action === "move") {
      console.log(`  ${write ? "✓" : "·"} ${verb} ${plan.userId}/${basename(plan.from)} → ${room}`);
    } else {
      console.log(
        `  ${write ? "✓" : "·"} ${plan.userId}/${basename(plan.from)} already at ${room} — ` +
          `${write ? "removed" : "would remove"} stale identity copy`,
      );
    }
  }

  console.log(
    `\n${summary.moved} ${write ? "moved" : "to move"} · ` +
      `${summary.skippedExisting} already migrated · ` +
      `${summary.users} user(s)`,
  );
  if (!write && summary.moved > 0) {
    console.log("\nDry run — re-run with --write to apply.");
  }
}

/** Last path segment, for the dry-run log. */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

// Gate the CLI side effect on direct invocation so tests can import
// `migrateFilesToRoom` without running the argv/console path.
if (import.meta.main) {
  main();
}
