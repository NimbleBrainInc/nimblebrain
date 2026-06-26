#!/usr/bin/env bun

/**
 * One-time migration: flat conversation store → the room-owned layout.
 *
 * The single user-scoped store at `{workDir}/conversations/<convId>.jsonl`
 * predates the room-owned layout, where a conversation lives under the
 * workspace it runs in with the owner as a privacy sub-partition (see
 * `src/conversation/paths.ts` and `research/SPEC-permission-boundaries.md`):
 *
 *   workspaces/<wsId>/conversations/<ownerId>/<convId>.jsonl          private user chats
 *   workspaces/<wsId>/conversations/_runs/<automationId>/<convId>.jsonl  automation runs
 *
 * This walks the flat dir and moves each file to its room-owned home. The
 * destination room is `meta.workspaceId` when set, else the owner's personal
 * workspace; an automation run (line-1 `metadata.source === "task"` with an
 * `metadata.automationId`) lands in that room's `_runs/<automationId>/`
 * partition instead of the owner partition.
 *
 * Usage:
 *   bun run migrate:conversations-to-room                  # dry-run (default)
 *   bun run migrate:conversations-to-room --write          # apply the moves
 *   bun run migrate:conversations-to-room --work-dir /abs  # target a work-dir
 *
 * Safe by default: a dry-run prints the planned moves, writes nothing, and
 * exits 0. `--write` (or `--apply`) performs the moves under the work-dir's
 * `.migration-lock`. Idempotent: a destination that already exists is treated
 * as already-migrated (the stale flat source is removed), so a re-run after a
 * crash or a partial run reports zero moves.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import {
  type ParsedConversationPath,
  parseConversationPath,
  roomConversationsDir,
  runConversationsDir,
} from "../src/conversation/paths.ts";
import { CONVERSATION_ID_RE } from "../src/conversation/types.ts";
import { personalWorkspaceIdFor } from "../src/workspace/workspace-store.ts";
import { acquireMigrationLock } from "./lib/migration-lock.ts";

const MIGRATION_NAME = "conversations-to-room";

/** Line-1 metadata shape this migration reads from each flat JSONL file. */
interface FlatConversationMeta {
  id?: string;
  createdAt?: string;
  ownerId?: string;
  workspaceId?: string;
  metadata?: {
    source?: string;
    automationId?: string;
    [key: string]: unknown;
  };
}

/** A single file's planned (dry-run) or performed (write) disposition. */
interface MovePlan {
  convId: string;
  from: string;
  to: string;
  /** `move` — relocate to a fresh dest; `existing` — dest already present, drop the stale source. */
  action: "move" | "existing";
}

export interface MigrationSummary {
  /** Files relocated to a fresh destination (or that would be, in dry-run). */
  moved: number;
  /** Files skipped because line-1 metadata lacked `ownerId` (pre-migration). */
  skippedOwnerless: number;
  /** Files whose destination already existed — treated as already-migrated. */
  skippedExisting: number;
  /** Files whose basename isn't a valid conversation id. */
  skippedInvalidId: number;
  /** Files whose line-1 metadata couldn't be parsed. */
  skippedUnreadable: number;
  /** The per-file dispositions, for printing / assertions. */
  plans: MovePlan[];
}

function emptySummary(): MigrationSummary {
  return {
    moved: 0,
    skippedOwnerless: 0,
    skippedExisting: 0,
    skippedInvalidId: 0,
    skippedUnreadable: 0,
    plans: [],
  };
}

/** Where one flat conversation file belongs in the room-owned layout. */
function destDirFor(workDir: string, meta: FlatConversationMeta, ownerId: string): string {
  const wsId = meta.workspaceId ?? personalWorkspaceIdFor(ownerId);
  const m = meta.metadata;
  // An automation run is `source === "task"` with a present automationId; it
  // lands in the room-visible `_runs/<automationId>/` partition, not the owner's.
  if (m?.source === "task" && typeof m.automationId === "string" && m.automationId.length > 0) {
    return runConversationsDir(workDir, wsId, m.automationId);
  }
  return roomConversationsDir(workDir, wsId, ownerId);
}

/**
 * Move `srcFile` to `destFile` without a window where neither (or a partial)
 * exists: write the content to a temp sibling in the destination dir, rename it
 * over the destination, then unlink the flat source.
 */
function atomicMove(srcFile: string, destDir: string, destFile: string, content: string): void {
  mkdirSync(destDir, { recursive: true });
  const tmpFile = join(destDir, `.${basename(destFile)}.${process.pid}.tmp`);
  writeFileSync(tmpFile, content, "utf-8");
  renameSync(tmpFile, destFile);
  unlinkSync(srcFile);
}

/**
 * Plan (and, when `write`, perform) the move of every flat conversation file
 * under `{workDir}/conversations/` into the room-owned layout. Pure read in
 * dry-run; acquires the work-dir migration lock for the write path.
 */
export function migrateConversationsToRoom(
  workDir: string,
  opts: { write: boolean },
): MigrationSummary {
  const summary = emptySummary();
  const flatDir = join(workDir, "conversations");

  let entries: string[];
  try {
    entries = readdirSync(flatDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name);
  } catch {
    // No flat dir — nothing to migrate (fresh or already-migrated install).
    return summary;
  }

  const lock = opts.write ? acquireMigrationLock(workDir, MIGRATION_NAME) : null;
  try {
    for (const name of entries) {
      const srcFile = join(flatDir, name);
      const convId = name.slice(0, -".jsonl".length);

      // Validate the id before it ever lands in a path segment.
      if (!CONVERSATION_ID_RE.test(convId)) {
        summary.skippedInvalidId++;
        continue;
      }

      let meta: FlatConversationMeta;
      let content: string;
      try {
        content = readFileSync(srcFile, "utf-8");
        const firstLine = content.split("\n", 1)[0] ?? "";
        meta = JSON.parse(firstLine) as FlatConversationMeta;
      } catch {
        summary.skippedUnreadable++;
        continue;
      }

      // Ownerless files predate the owner invariant: with no owner there is no
      // room (and no `_runs` owner) to migrate into. Skip, count, warn once.
      if (!meta.ownerId) {
        summary.skippedOwnerless++;
        continue;
      }

      const destDir = destDirFor(workDir, meta, meta.ownerId);
      const destFile = join(destDir, `${convId}.jsonl`);

      if (existsSync(destFile)) {
        // Already migrated (a prior crash/partial run, or a re-run). The
        // canonical copy is the dest; the flat source is stale.
        summary.skippedExisting++;
        summary.plans.push({ convId, from: srcFile, to: destFile, action: "existing" });
        if (opts.write) unlinkSync(srcFile);
        continue;
      }

      summary.plans.push({ convId, from: srcFile, to: destFile, action: "move" });
      if (opts.write) atomicMove(srcFile, destDir, destFile, content);
      summary.moved++;
    }
  } finally {
    lock?.release();
  }

  return summary;
}

/** Human-readable room label for a planned destination, for the dry-run log. */
function roomLabel(destFile: string): string {
  const parsed: ParsedConversationPath | null = parseConversationPath(destFile);
  if (!parsed) return destFile;
  if (parsed.automationId) return `${parsed.wsId} · _runs/${parsed.automationId}`;
  return `${parsed.wsId} · ${parsed.ownerId}`;
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

  const summary = migrateConversationsToRoom(workDir, { write });

  const verb = write ? "Moved" : "Would move";
  for (const plan of summary.plans) {
    if (plan.action === "move") {
      console.log(`  ${write ? "✓" : "·"} ${verb} ${plan.convId} → ${roomLabel(plan.to)}`);
    } else {
      console.log(
        `  ${write ? "✓" : "·"} ${plan.convId} already at ${roomLabel(plan.to)} — ` +
          `${write ? "removed" : "would remove"} stale flat copy`,
      );
    }
  }

  if (summary.skippedOwnerless > 0) {
    console.warn(
      `\n  ! ${summary.skippedOwnerless} ownerless conversation file(s) left in place — ` +
        "they predate the owner invariant (no ownerId → no room to migrate into); stamp ownerId first.",
    );
  }
  if (summary.skippedInvalidId > 0) {
    console.warn(
      `  ! ${summary.skippedInvalidId} file(s) skipped — basename is not a conversation id.`,
    );
  }
  if (summary.skippedUnreadable > 0) {
    console.warn(`  ! ${summary.skippedUnreadable} file(s) skipped — unreadable line-1 metadata.`);
  }

  console.log(
    `\n${summary.moved} ${write ? "moved" : "to move"} · ` +
      `${summary.skippedExisting} already migrated · ` +
      `${summary.skippedOwnerless} ownerless · ` +
      `${summary.skippedInvalidId + summary.skippedUnreadable} unmigratable`,
  );
  if (!write && summary.moved > 0) {
    console.log("\nDry run — re-run with --write to apply.");
  }
}

// Gate the CLI side effect on direct invocation so tests can import
// `migrateConversationsToRoom` without running the argv/console path.
if (import.meta.main) {
  main();
}
