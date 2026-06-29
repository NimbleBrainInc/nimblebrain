#!/usr/bin/env bun

/**
 * One-time migration: identity-owned file store → the room-owned layout.
 *
 * Files used to live under the user's identity partition at
 * `{workDir}/users/<userId>/files/` — a per-user `registry.jsonl` catalog, the
 * byte files (`<fileId>_<sanitizedName>`), and the extracted-text sidecars
 * (`<fileId>.extracted.json`). The room now owns the directory (see
 * `src/files/paths.ts` and `research/SPEC-permission-boundaries.md`): a file
 * lives under the workspace it belongs to, with the owner as a privacy
 * sub-partition that is self-contained — its own registry, bytes, and sidecars:
 *
 *   workspaces/<wsId>/files/<ownerId>/registry.jsonl       per-owner catalog
 *   workspaces/<wsId>/files/<ownerId>/<fileId>_<name>      owner-private bytes
 *   workspaces/<wsId>/files/<ownerId>/<fileId>.extracted.json   extracted text
 *
 * This walks each `users/<userId>/files/` directory and relocates every catalog
 * entry to its room-owned home. The destination room is the entry's
 * `workspaceId` when set, else the user's personal workspace; the owner is the
 * user. The byte file and sidecar move to the owner partition and the entry —
 * stamped with `ownerId`/`workspaceId` — is appended to that partition's
 * `registry.jsonl`. Tombstones (`deleted: true`) copy through with no byte file,
 * so deletes survive the migration.
 *
 * Usage:
 *   bun run migrate:files-to-room                  # dry-run (default)
 *   bun run migrate:files-to-room --write          # apply the moves
 *   bun run migrate:files-to-room --work-dir /abs  # target a work-dir
 *
 * Safe by default: a dry-run prints the planned moves, writes nothing, and
 * exits 0. `--write` (or `--apply`) performs the moves under the work-dir's
 * `.migration-lock`. Idempotent: an entry already recorded in the destination
 * registry (or whose dest byte file already exists) is treated as
 * already-migrated, so a re-run after a crash or partial run reports zero moves.
 * An un-migratable entry (a live, non-tombstone entry whose byte file is missing
 * on disk) is left in place, counted, and warned about once for manual triage.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ParsedFilesPath, parseFilesPath, roomFilesDir } from "../src/files/paths.ts";
import type { FileEntry } from "../src/files/types.ts";
// The ONE servable-file-id validator — shared with the serve handler so a
// legacy `fl_<base36>_<8 hex>` id the runtime still serves can never be skipped
// (and thus orphaned) by the migration.
import { FILE_ID_RE } from "../src/files/uri.ts";
import { personalWorkspaceIdFor } from "../src/workspace/workspace-store.ts";
import { acquireMigrationLock } from "./lib/migration-lock.ts";

const MIGRATION_NAME = "files-to-room";

/** A single entry's planned (dry-run) or performed (write) disposition. */
interface MovePlan {
  fileId: string;
  wsId: string;
  ownerId: string;
  /** `bytes` — a live file (byte file + optional sidecar); `tombstone` — a delete record. */
  kind: "bytes" | "tombstone";
  /** `move` — relocate to a fresh dest; `existing` — already migrated, drop the stale source. */
  action: "move" | "existing";
  /** The owner partition the entry lands in. */
  to: string;
}

export interface FileMigrationSummary {
  /** Entries relocated to a fresh destination (or that would be, in dry-run). */
  moved: number;
  /** Entries skipped because the destination already has them — already-migrated. */
  skippedExisting: number;
  /** Live entries left in place because their byte file is missing on disk. */
  skippedMissingBytes: number;
  /** Entries whose id isn't a servable file id (fails `FILE_ID_RE`) — malformed,
   *  never a shape the runtime would serve. */
  skippedInvalidId: number;
  /** Registry lines that couldn't be parsed as JSON. */
  skippedUnreadable: number;
  /** The per-entry dispositions, for printing / assertions. */
  plans: MovePlan[];
}

function emptySummary(): FileMigrationSummary {
  return {
    moved: 0,
    skippedExisting: 0,
    skippedMissingBytes: 0,
    skippedInvalidId: 0,
    skippedUnreadable: 0,
    plans: [],
  };
}

/**
 * Move `srcFile` to `destDir/destName` without a window where a partial file is
 * visible at the destination: copy the bytes to a temp sibling in the
 * destination dir, rename it over the destination, then unlink the source.
 */
function atomicMove(srcFile: string, destDir: string, destName: string): void {
  mkdirSync(destDir, { recursive: true });
  const destFile = join(destDir, destName);
  const tmpFile = join(destDir, `.${destName}.${process.pid}.tmp`);
  writeFileSync(tmpFile, readFileSync(srcFile));
  renameSync(tmpFile, destFile);
  unlinkSync(srcFile);
}

/** The set of file ids already recorded in a destination owner registry. */
function readDestRegistryIds(destRegistry: string): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(destRegistry)) return ids;
  const content = readFileSync(destRegistry, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as { id?: string };
      if (typeof entry.id === "string") ids.add(entry.id);
    } catch {
      // A malformed dest line can't claim an id; ignore it for membership.
    }
  }
  return ids;
}

/**
 * Collapse a user's append-log `registry.jsonl` to the latest entry per id
 * (last-write-wins, exactly how the store reads it). Tombstones surface as the
 * latest entry with `deleted: true`. Unparseable lines bump `skippedUnreadable`.
 */
function collapseRegistry(
  registryPath: string,
  summary: FileMigrationSummary,
): Map<string, FileEntry> {
  const latest = new Map<string, FileEntry>();
  if (!existsSync(registryPath)) return latest;
  const content = readFileSync(registryPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: FileEntry;
    try {
      entry = JSON.parse(trimmed) as FileEntry;
    } catch {
      summary.skippedUnreadable++;
      continue;
    }
    if (typeof entry.id === "string") latest.set(entry.id, entry);
  }
  return latest;
}

/** The user directories under `{workDir}/users/<userId>/files/`. */
function userIdsWithFiles(workDir: string): string[] {
  const usersDir = join(workDir, "users");
  let entries: string[];
  try {
    entries = readdirSync(usersDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries.filter((userId) => existsSync(join(usersDir, userId, "files")));
}

/**
 * Plan (and, when `write`, perform) the relocation of every identity-owned file
 * entry into its room-owned owner partition. Pure read in dry-run; acquires the
 * work-dir migration lock for the write path. Returned summary is exported for
 * the integration test.
 */
export function migrateFilesToRoom(
  workDir: string,
  opts: { write: boolean },
): FileMigrationSummary {
  const summary = emptySummary();
  const userIds = userIdsWithFiles(workDir);
  if (userIds.length === 0) return summary;

  // One id-set per destination owner registry, kept in sync as we append, so an
  // entry whose id is already present is recognised as already-migrated.
  const destRegistryIds = new Map<string, Set<string>>();
  const destIds = (destRegistry: string): Set<string> => {
    let ids = destRegistryIds.get(destRegistry);
    if (!ids) {
      ids = readDestRegistryIds(destRegistry);
      destRegistryIds.set(destRegistry, ids);
    }
    return ids;
  };

  const lock = opts.write ? acquireMigrationLock(workDir, MIGRATION_NAME) : null;
  try {
    for (const userId of userIds) {
      const userFilesDir = join(workDir, "users", userId, "files");
      const sourceNames = readdirSync(userFilesDir);
      const entries = collapseRegistry(join(userFilesDir, "registry.jsonl"), summary);

      for (const [fileId, entry] of entries) {
        // Validate against the SAME id shape the serve handler accepts (both the
        // current `fl_<24hex>` and legacy `fl_<base36>_<8hex>` schemes), so a
        // servable id is never skipped and orphaned. Rejects only truly
        // malformed ids before they reach a path segment.
        if (!FILE_ID_RE.test(fileId)) {
          summary.skippedInvalidId++;
          continue;
        }

        const wsId = entry.workspaceId ?? personalWorkspaceIdFor(userId);
        const destDir = roomFilesDir(workDir, wsId, userId);
        const destRegistry = join(destDir, "registry.jsonl");
        const ids = destIds(destRegistry);

        const srcByteName = sourceNames.find((n) => n.startsWith(`${fileId}_`));

        // Already migrated: the dest registry records this id, or its bytes are
        // already at the destination (a prior crash between the byte move and
        // the registry append). The dest copy is canonical; drop stale source.
        const destHasBytes =
          existsSync(destDir) && readdirSync(destDir).some((n) => n.startsWith(`${fileId}_`));
        if (ids.has(fileId) || destHasBytes) {
          summary.skippedExisting++;
          summary.plans.push({
            fileId,
            wsId,
            ownerId: userId,
            kind: entry.deleted ? "tombstone" : "bytes",
            action: "existing",
            to: destDir,
          });
          if (opts.write) {
            if (srcByteName) unlinkSync(join(userFilesDir, srcByteName));
            const srcSidecar = join(userFilesDir, `${fileId}.extracted.json`);
            if (existsSync(srcSidecar)) unlinkSync(srcSidecar);
          }
          continue;
        }

        // A tombstone copies through with no byte file — the delete must survive.
        if (entry.deleted) {
          summary.plans.push({
            fileId,
            wsId,
            ownerId: userId,
            kind: "tombstone",
            action: "move",
            to: destDir,
          });
          if (opts.write) {
            appendEntry(destDir, destRegistry, entry, userId, wsId);
            ids.add(fileId);
          }
          summary.moved++;
          continue;
        }

        // A live entry needs its byte file. Missing bytes are un-migratable —
        // leave the entry in place for manual triage.
        if (!srcByteName) {
          summary.skippedMissingBytes++;
          continue;
        }

        summary.plans.push({
          fileId,
          wsId,
          ownerId: userId,
          kind: "bytes",
          action: "move",
          to: destDir,
        });
        if (opts.write) {
          atomicMove(join(userFilesDir, srcByteName), destDir, srcByteName);
          const srcSidecar = join(userFilesDir, `${fileId}.extracted.json`);
          if (existsSync(srcSidecar)) {
            atomicMove(srcSidecar, destDir, `${fileId}.extracted.json`);
          }
          appendEntry(destDir, destRegistry, entry, userId, wsId);
          ids.add(fileId);
        }
        summary.moved++;
      }
    }
  } finally {
    lock?.release();
  }

  return summary;
}

/** Append the entry, stamped with its owner/room, to the dest owner registry. */
function appendEntry(
  destDir: string,
  destRegistry: string,
  entry: FileEntry,
  ownerId: string,
  wsId: string,
): void {
  mkdirSync(destDir, { recursive: true });
  const stamped: FileEntry = { ...entry, ownerId, workspaceId: wsId };
  appendFileSync(destRegistry, `${JSON.stringify(stamped)}\n`, "utf-8");
}

/** Human-readable room label for a planned destination, for the dry-run log. */
function roomLabel(destDir: string): string {
  const parsed: ParsedFilesPath | null = parseFilesPath(join(destDir, "registry.jsonl"));
  if (!parsed) return destDir;
  return `${parsed.wsId} · ${parsed.ownerId ?? "_runs"}`;
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
    const what = plan.kind === "tombstone" ? "tombstone" : "file";
    if (plan.action === "move") {
      console.log(`  ${write ? "✓" : "·"} ${verb} ${what} ${plan.fileId} → ${roomLabel(plan.to)}`);
    } else {
      console.log(
        `  ${write ? "✓" : "·"} ${plan.fileId} already at ${roomLabel(plan.to)} — ` +
          `${write ? "removed" : "would remove"} stale identity copy`,
      );
    }
  }

  if (summary.skippedMissingBytes > 0) {
    console.warn(
      `\n  ! ${summary.skippedMissingBytes} file entr(y/ies) left in place — the registry lists ` +
        "them but no byte file is on disk (a partial/corrupt identity store). Manual triage: " +
        "locate the missing bytes and restore them under the user's files dir before re-running, " +
        "or remove the orphaned registry entries.",
    );
  }
  if (summary.skippedInvalidId > 0) {
    console.warn(
      `  ! ${summary.skippedInvalidId} entr(y/ies) skipped — malformed id (not a shape the runtime ` +
        "serves: `fl_<24hex>` or legacy `fl_<base36>_<8hex>`). These are not servable; review the source registry.",
    );
  }
  if (summary.skippedUnreadable > 0) {
    console.warn(`  ! ${summary.skippedUnreadable} registry line(s) skipped — unparseable JSON.`);
  }

  console.log(
    `\n${summary.moved} ${write ? "moved" : "to move"} · ` +
      `${summary.skippedExisting} already migrated · ` +
      `${summary.skippedMissingBytes} missing bytes · ` +
      `${summary.skippedInvalidId + summary.skippedUnreadable} unmigratable`,
  );
  if (!write && summary.moved > 0) {
    console.log("\nDry run — re-run with --write to apply.");
  }
}

// Gate the CLI side effect on direct invocation so tests can import
// `migrateFilesToRoom` without running the argv/console path.
if (import.meta.main) {
  main();
}
