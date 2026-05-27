#!/usr/bin/env bun
/**
 * Phase B migration: move every file from the workspace-scoped store
 * `{workDir}/workspaces/{wsId}/files/` to the identity-scoped store
 * `{workDir}/users/{ownerId}/files/`.
 *
 * Files become identity-owned: a file belongs to the user, not a workspace.
 * The workspace a file was created in is preserved as a provenance breadcrumb
 * (`FileEntry.workspaceId`), never the storage key — mirrors how a
 * conversation's `workspaceId` records tool-scope, not file location.
 *
 * Owner resolution (Mat's call, 2026-05):
 *   - Personal workspace (`isPersonal` / `ws_user_<id>`): owner = `ownerUserId`.
 *   - Team workspace: owner = the earliest `role: "admin"` in `members[]`
 *     (creation order; the creator is the first member). Team workspaces are
 *     forbidden from carrying `ownerUserId`, so membership is the only source.
 *   - No admin, or no readable `workspace.json`: **[FATAL]** — operator must
 *     reconcile. We never invent an owner.
 *
 * Safety model — clean one-way move, idempotent on the destination:
 *   1. Copy the blob `{id}_{name}` to the destination.
 *   2. Copy the extracted-text sidecar `{id}.extracted.json` if present.
 *   3. Append the (provenance-stamped) registry line to the destination
 *      `registry.jsonl` — this is the commit point.
 *   4. Delete the source blob + sidecar.
 * After all files are moved, each emptied `workspaces/{wsId}/files/` dir is
 * removed entirely (registry + dir) — no residue, no deferred cleanup pass.
 * A crash between (1) and (3) is healed on re-run: the destination blob is the
 * sentinel, but we still append a missing registry line (tracked per owner) so
 * the window can't strand a blob without its metadata.
 *
 * Cross-workspace `fl_` id collisions (the same id under two workspace file
 * dirs) are a `[FATAL]` exit: file ids are random; a collision is corruption.
 *
 * Designed to run during a maintenance window with the platform stopped.
 * Idempotent — a second run reports zero copies.
 *
 * Usage:
 *     bun run scripts/migrate-files-to-identity.ts [--work-dir <path>] [--dry-run]
 */

import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { acquireMigrationLock } from "./lib/migration-lock.ts";
import { resolveWorkspaceOwner } from "./lib/resolve-workspace-owner.ts";

/** Local copy of the on-disk registry entry — inlined so the script survives
 * type changes in `src/files/types.ts`. `workspaceId` is the provenance field
 * Phase B adds; this script stamps it. */
interface FileEntry {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  tags: string[];
  source: string;
  conversationId: string | null;
  createdAt: string;
  description: string | null;
  workspaceId?: string;
  deleted?: boolean;
  deletedAt?: string;
}

interface Args {
  workDir: string;
  dryRun: boolean;
}

interface Candidate {
  wsId: string;
  ownerId: string;
  entry: FileEntry;
  diskName: string; // `{id}_{sanitizedName}` on disk
  srcDir: string; // workspaces/{wsId}/files
}

interface Stats {
  found: number;
  migrated: number;
  alreadyMigrated: number;
  tombstoned: number;
  missingOnDisk: number;
  errors: { ctx: string; message: string }[];
}

const SIDECAR_SUFFIX = ".extracted.json";

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let workDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--work-dir") {
      workDir = argv[++i] ?? "";
    } else if (arg?.startsWith("--work-dir=")) {
      workDir = arg.slice("--work-dir=".length);
    } else {
      console.error(`[migrate-files] unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }
  if (!workDir) {
    console.error("[migrate-files] --work-dir is required (or set NB_WORK_DIR)");
    process.exit(2);
  }
  return { workDir, dryRun };
}

function printHelp(): void {
  console.log(`
migrate-files-to-identity — Phase B of the identity-app surface

Moves every file from workspaces/{wsId}/files/ to users/{ownerId}/files/,
stamping the source workspace as provenance (FileEntry.workspaceId). Owner is
the personal-workspace user, or a team workspace's earliest admin.

Usage:
  bun run scripts/migrate-files-to-identity.ts [options]

Options:
  --work-dir <path>   Override the work directory. Defaults to
                      $NB_WORK_DIR or ~/.nimblebrain.
  --dry-run           Report the planned copies without writing.
  -h, --help          This message.

Run during a maintenance window with the platform stopped. Idempotent.
Unresolvable team-workspace ownership and cross-workspace id collisions exit
non-zero with [FATAL]; operators decide.
`);
}

/** Collapse a workspace registry to the latest entry per id (last-write-wins),
 * matching the runtime store's read semantics. */
function latestPerId(entries: FileEntry[]): Map<string, FileEntry> {
  const latest = new Map<string, FileEntry>();
  for (const e of entries) latest.set(e.id, e);
  return latest;
}

async function readRegistry(registryPath: string): Promise<FileEntry[]> {
  let content: string;
  try {
    content = await readFile(registryPath, "utf-8");
  } catch {
    return [];
  }
  const out: FileEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as FileEntry);
    } catch {
      // Skip malformed lines — don't fail the whole registry on one bad line.
    }
  }
  return out;
}

async function findDiskName(filesDir: string, id: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(filesDir);
  } catch {
    return null;
  }
  return entries.find((e) => e.startsWith(`${id}_`)) ?? null;
}

/** Build the migration plan. Collects every live file candidate, and the
 * fatal conditions (unresolvable owners, cross-workspace id collisions). */
async function plan(
  workspacesDir: string,
): Promise<{
  candidates: Candidate[];
  tombstoned: number;
  unresolvable: string[];
  collisions: Map<string, string[]>;
}> {
  const candidates: Candidate[] = [];
  const unresolvable: string[] = [];
  const idToWorkspaces = new Map<string, string[]>();
  let tombstoned = 0;

  if (!existsSync(workspacesDir)) {
    return { candidates, tombstoned, unresolvable, collisions: new Map() };
  }

  const ownerCache = new Map<string, string | null>();
  for (const wsEntry of await readdir(workspacesDir, { withFileTypes: true })) {
    if (!wsEntry.isDirectory() || wsEntry.name.startsWith(".")) continue;
    const wsId = wsEntry.name;
    const srcDir = join(workspacesDir, wsId, "files");
    if (!existsSync(srcDir)) continue;

    const live = latestPerId(await readRegistry(join(srcDir, "registry.jsonl")));
    if (live.size === 0) continue;

    if (!ownerCache.has(wsId)) ownerCache.set(wsId, await resolveWorkspaceOwner(workspacesDir, wsId));
    const owner = ownerCache.get(wsId) ?? null;

    for (const entry of live.values()) {
      if (entry.deleted) {
        tombstoned++;
        continue;
      }
      idToWorkspaces.set(entry.id, [...(idToWorkspaces.get(entry.id) ?? []), wsId]);
      if (owner === null) {
        unresolvable.push(`${wsId}/${entry.id}`);
        continue;
      }
      const diskName = await findDiskName(srcDir, entry.id);
      if (!diskName) {
        // Registry entry but no blob on disk — recorded as missingOnDisk by the
        // executor; carry it through so the summary counts it.
        candidates.push({ wsId, ownerId: owner, entry, diskName: "", srcDir });
        continue;
      }
      candidates.push({ wsId, ownerId: owner, entry, diskName, srcDir });
    }
  }

  const collisions = new Map<string, string[]>();
  for (const [id, wss] of idToWorkspaces) {
    if (wss.length > 1) collisions.set(id, wss);
  }
  return { candidates, tombstoned, unresolvable, collisions };
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(`[migrate-files] workDir=${args.workDir}${args.dryRun ? " (dry-run)" : ""}`);

  if (!existsSync(args.workDir)) {
    console.error(`[migrate-files] workDir does not exist: ${args.workDir}`);
    process.exit(1);
  }

  acquireMigrationLock(args.workDir, "migrate-files-to-identity");

  const workspacesDir = join(args.workDir, "workspaces");
  const { candidates, tombstoned, unresolvable, collisions } = await plan(workspacesDir);

  // Phase 1 — fatal conditions. Refuse the whole batch rather than half-migrate.
  if (collisions.size > 0) {
    console.error(
      `[migrate-files] [FATAL] same file id appears under multiple workspaces (${collisions.size}):`,
    );
    for (const [id, wss] of collisions) console.error(`[migrate-files]   ${id}: ${wss.join(", ")}`);
    console.error(`[migrate-files] [FATAL] file ids are random; a collision is corruption. Refusing.`);
    process.exit(2);
  }
  if (unresolvable.length > 0) {
    console.error(
      `[migrate-files] [FATAL] ${unresolvable.length} file(s) in workspaces with no resolvable owner ` +
        `(team workspace with no admin, or unreadable workspace.json):`,
    );
    for (const ref of unresolvable) console.error(`[migrate-files]   ${ref}`);
    console.error(`[migrate-files] [FATAL] operator must assign an owner. Refusing to guess.`);
    process.exit(2);
  }

  const stats: Stats = {
    found: candidates.length,
    migrated: 0,
    alreadyMigrated: 0,
    tombstoned,
    missingOnDisk: 0,
    errors: [],
  };

  // Per-owner cache of registry ids already at the destination — closes the
  // crash window where a blob copied but its registry line didn't.
  const destRegistryIds = new Map<string, Set<string>>();
  async function destIds(ownerFilesDir: string): Promise<Set<string>> {
    const cached = destRegistryIds.get(ownerFilesDir);
    if (cached) return cached;
    const ids = new Set<string>();
    for (const e of await readRegistry(join(ownerFilesDir, "registry.jsonl"))) ids.add(e.id);
    destRegistryIds.set(ownerFilesDir, ids);
    return ids;
  }

  for (const cand of candidates) {
    const ctx = `${cand.wsId}/${cand.entry.id}`;
    try {
      if (cand.diskName === "") {
        console.error(`[migrate-files] skip ${ctx} — registry entry but no blob on disk`);
        stats.missingOnDisk++;
        continue;
      }
      const destDir = join(args.workDir, "users", cand.ownerId, "files");
      const destBlob = join(destDir, cand.diskName);
      const ids = await destIds(destDir);

      if (existsSync(destBlob)) {
        // Already migrated. Heal a missing registry line from a prior partial run.
        if (!ids.has(cand.entry.id)) {
          if (args.dryRun) {
            console.error(`[migrate-files]   [dry-run] would heal registry line for ${ctx}`);
          } else {
            await appendFile(
              join(destDir, "registry.jsonl"),
              `${JSON.stringify({ ...cand.entry, workspaceId: cand.wsId })}\n`,
            );
            ids.add(cand.entry.id);
          }
        }
        stats.alreadyMigrated++;
        continue;
      }

      if (args.dryRun) {
        console.error(`[migrate-files]   [dry-run] would move ${ctx} → users/${cand.ownerId}/files`);
        stats.migrated++;
        continue;
      }

      await mkdir(destDir, { recursive: true });
      // 1. blob, 2. sidecar, 3. registry (commit), 4. delete sources.
      await copyFile(join(cand.srcDir, cand.diskName), destBlob);
      const sidecar = `${cand.entry.id}${SIDECAR_SUFFIX}`;
      const srcSidecar = join(cand.srcDir, sidecar);
      if (existsSync(srcSidecar)) await copyFile(srcSidecar, join(destDir, sidecar));
      await appendFile(
        join(destDir, "registry.jsonl"),
        `${JSON.stringify({ ...cand.entry, workspaceId: cand.wsId })}\n`,
      );
      ids.add(cand.entry.id);
      await unlink(join(cand.srcDir, cand.diskName));
      if (existsSync(srcSidecar)) await unlink(srcSidecar);
      stats.migrated++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[migrate-files] ERROR ${ctx}: ${message}`);
      stats.errors.push({ ctx, message });
    }
  }

  // Clean one-way move: remove each emptied source files dir entirely (no
  // residue, no deferred cleanup). A dir that still holds a blob — e.g. a
  // sibling of a skipped missing-on-disk entry — is left for operator review.
  let dirsRemoved = 0;
  if (!args.dryRun && stats.errors.length === 0) {
    for (const srcDir of new Set(candidates.map((c) => c.srcDir))) {
      let remaining: string[];
      try {
        remaining = await readdir(srcDir);
      } catch {
        continue; // already removed
      }
      const blobsLeft = remaining.some(
        (e) => e.startsWith("fl_") && !e.endsWith(SIDECAR_SUFFIX),
      );
      if (blobsLeft) {
        console.error(`[migrate-files]   left ${srcDir} in place (blobs remain)`);
        continue;
      }
      await rm(srcDir, { recursive: true, force: true });
      dirsRemoved++;
    }
  }

  console.error("");
  console.error(`[migrate-files] summary${args.dryRun ? " (dry-run)" : ""}:`);
  console.error(`[migrate-files]   files found (live):  ${stats.found}`);
  console.error(`[migrate-files]   migrated:            ${stats.migrated}`);
  console.error(`[migrate-files]   already migrated:    ${stats.alreadyMigrated}`);
  console.error(`[migrate-files]   tombstoned (skip):   ${stats.tombstoned}`);
  console.error(`[migrate-files]   missing on disk:     ${stats.missingOnDisk}`);
  console.error(`[migrate-files]   source dirs removed: ${dirsRemoved}`);
  console.error(`[migrate-files]   collisions:          0`);
  console.error(`[migrate-files]   unresolvable owners: 0`);
  console.error(`[migrate-files]   errors:              ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    for (const e of stats.errors) console.error(`[migrate-files]     [error] ${e.ctx}: ${e.message}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
