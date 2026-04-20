#!/usr/bin/env bun
/**
 * One-shot migration for the pre-unification chat-upload path.
 *
 * The broken path wrote chat uploads to `<workDir>/files/` (tenant-global)
 * instead of `<workDir>/workspaces/<wsId>/files/`. After the factory
 * signature change this directory is no longer written to; existing
 * files in it are invisible to the `files__*` tools until they're moved
 * into the workspace dir that owns their conversation.
 *
 * This script is non-destructive: it copies files + appends registry
 * entries; it does not touch the source directory. A later PR will
 * delete the source after prod verifies every historical file
 * resolves through the new path.
 *
 * Invariants:
 *  - File ids are preserved. The unified regex accepts both the new
 *    `fl_<24 hex>` scheme and the legacy `fl_<base36>_<8 hex>` scheme,
 *    so historical conversation references keep resolving without an
 *    aliases table.
 *  - Idempotent: the presence of the target disk file is the sentinel.
 *
 * Usage:
 *     bun run scripts/migrate-tenant-files.ts [workDir]
 *
 * `workDir` defaults to `$NB_WORK_DIR` or `/data`. On a platform pod:
 *     bun run scripts/migrate-tenant-files.ts /data
 */

import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

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
  deleted?: boolean;
  deletedAt?: string;
}

interface Stats {
  scanned: number;
  migrated: number;
  alreadyMigrated: number;
  unresolvable: number;
  missingOnDisk: number;
  tombstoned: number;
}

async function readJsonlRegistry(registryPath: string): Promise<FileEntry[]> {
  const content = await readFile(registryPath, "utf-8");
  const entries: FileEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as FileEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/** Build a convId → wsId map by scanning all workspaces' conversation dirs. */
async function buildConversationIndex(workspacesDir: string): Promise<Map<string, string>> {
  const convToWs = new Map<string, string>();
  if (!existsSync(workspacesDir)) return convToWs;
  for (const wsId of await readdir(workspacesDir)) {
    if (wsId.startsWith(".")) continue;
    const convDir = join(workspacesDir, wsId, "conversations");
    if (!existsSync(convDir)) continue;
    for (const file of await readdir(convDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const convId = basename(file, ".jsonl");
      convToWs.set(convId, wsId);
    }
  }
  return convToWs;
}

async function findDiskFile(filesDir: string, id: string): Promise<string | null> {
  const entries = await readdir(filesDir);
  const match = entries.find((e) => e.startsWith(`${id}_`));
  return match ? join(filesDir, match) : null;
}

async function main(): Promise<void> {
  const workDir = process.argv[2] ?? process.env.NB_WORK_DIR ?? "/data";
  const oldFilesDir = join(workDir, "files");
  const oldRegistryPath = join(oldFilesDir, "registry.jsonl");
  const workspacesDir = join(workDir, "workspaces");

  console.error(`[migrate] workDir=${workDir}`);

  if (!existsSync(oldRegistryPath)) {
    console.error(`[migrate] no old registry at ${oldRegistryPath} — nothing to do`);
    return;
  }

  const convIndex = await buildConversationIndex(workspacesDir);
  console.error(`[migrate] indexed ${convIndex.size} conversations across workspaces`);

  const entries = await readJsonlRegistry(oldRegistryPath);
  const stats: Stats = {
    scanned: entries.length,
    migrated: 0,
    alreadyMigrated: 0,
    unresolvable: 0,
    missingOnDisk: 0,
    tombstoned: 0,
  };

  // If the same id appears multiple times (tag updates, tombstones), keep all
  // lines but treat the last one as authoritative for the "is tombstoned"
  // decision. The new registry does last-write-wins too.
  const latest = new Map<string, FileEntry>();
  for (const e of entries) latest.set(e.id, e);

  for (const entry of latest.values()) {
    if (entry.deleted) {
      stats.tombstoned++;
      continue;
    }
    const convId = entry.conversationId;
    const wsId = convId ? convIndex.get(convId) : undefined;
    if (!wsId) {
      console.error(
        `[migrate] skip ${entry.id} — conversation ${convId ?? "(none)"} not resolvable`,
      );
      stats.unresolvable++;
      continue;
    }

    const diskSource = await findDiskFile(oldFilesDir, entry.id);
    if (!diskSource) {
      console.error(`[migrate] skip ${entry.id} — registry entry but file missing on disk`);
      stats.missingOnDisk++;
      continue;
    }

    const targetFilesDir = join(workspacesDir, wsId, "files");
    const targetDiskPath = join(targetFilesDir, basename(diskSource));
    if (existsSync(targetDiskPath)) {
      stats.alreadyMigrated++;
      continue;
    }

    await mkdir(targetFilesDir, { recursive: true });
    await copyFile(diskSource, targetDiskPath);
    await appendFile(
      join(targetFilesDir, "registry.jsonl"),
      `${JSON.stringify(entry)}\n`,
      "utf-8",
    );
    stats.migrated++;
  }

  console.error(`[migrate] done ${JSON.stringify(stats)}`);
}

main().catch((err) => {
  console.error(`[migrate] fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
