#!/usr/bin/env bun
/**
 * Backfill MIME types for files stored before ingest-time recovery existed.
 *
 * Files whose extension the browser didn't recognise (Typst `.typ` and most
 * source/config formats) used to arrive with an empty Content-Type that the
 * upload handlers coerced to `application/octet-stream`. Every text path keys
 * off MIME, so those files were stored as opaque binary and could not be read
 * back. Ingest now re-derives a text type from the filename (`resolveMimeType`,
 * the three mint sites), and the store recovers the type at read time — but
 * neither rewrites what's already on disk, so the stored registry still shows
 * `application/octet-stream` and any consumer that trusts the stored value
 * (`files://` resource metadata, the REST download `Content-Type`) keeps
 * serving the wrong type.
 *
 * This one-shot script corrects the stored truth. For every identity store
 * (`users/{userId}/files/registry.jsonl`) it collapses the append-only log to
 * the latest state per id, skips tombstoned entries, and for any live entry
 * whose filename resolves to a different (text) type than its stored generic
 * type, appends a corrected entry. Recovery is monotonic (`resolveMimeType`
 * only ever turns a generic/empty type into a text type for a known
 * text/source extension), so it never mislabels real binary, and a second run
 * is a no-op.
 *
 * Usage:
 *   bun run scripts/backfill-file-mime.ts [--work-dir <dir>] [--apply]
 *
 *   --work-dir <dir>  Platform work dir (default: $NB_WORK_DIR or /data).
 *   --apply           Write corrections. Omitted = dry run (report only).
 */

import { existsSync } from "node:fs";
import { appendFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveMimeType } from "../src/files/mime.ts";

/** Local copy of the on-disk registry entry — inlined so the script survives
 * type changes in `src/files/types.ts`. */
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
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  let workDir = process.env.NB_WORK_DIR || "/data";
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--work-dir") workDir = argv[++i] ?? workDir;
    else if (a === "--apply") apply = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: bun run scripts/backfill-file-mime.ts [--work-dir <dir>] [--apply]\n\n" +
          "Re-derives a text MIME type from the filename for files stored as\n" +
          "application/octet-stream (or empty). Dry run by default; pass --apply\n" +
          "to write corrections.",
      );
      process.exit(0);
    }
  }
  return { workDir, apply };
}

async function readRegistryRaw(registryPath: string): Promise<FileEntry[]> {
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

/** Collapse the append-only log to the latest state per id (last-write-wins),
 * matching `FileStore.readRegistry`. Tombstones are kept here and filtered by
 * the caller so a deleted file is never resurrected by a correction. */
function latestPerId(entries: FileEntry[]): Map<string, FileEntry> {
  const latest = new Map<string, FileEntry>();
  for (const e of entries) latest.set(e.id, e);
  return latest;
}

async function backfillStore(
  registryPath: string,
  apply: boolean,
): Promise<{ corrected: number; skippedDeleted: number; alreadyOk: number }> {
  const latest = latestPerId(await readRegistryRaw(registryPath));
  let corrected = 0;
  let skippedDeleted = 0;
  let alreadyOk = 0;

  for (const entry of latest.values()) {
    if (entry.deleted) {
      skippedDeleted++;
      continue;
    }
    const resolved = resolveMimeType(entry.filename, entry.mimeType);
    if (resolved === entry.mimeType) {
      alreadyOk++;
      continue;
    }
    corrected++;
    console.log(
      `  ${apply ? "fix " : "would fix"}: ${entry.filename} (${entry.id})  ${entry.mimeType} -> ${resolved}`,
    );
    if (apply) {
      // Append the full latest entry with the corrected type so provenance
      // (tags, workspaceId, createdAt, …) is preserved and last-write-wins
      // resolves to the fixed value.
      await appendFile(registryPath, `${JSON.stringify({ ...entry, mimeType: resolved })}\n`);
    }
  }

  return { corrected, skippedDeleted, alreadyOk };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const usersDir = join(args.workDir, "users");
  if (!existsSync(usersDir)) {
    console.error(`[backfill-mime] no users dir at ${usersDir} — nothing to do.`);
    process.exit(0);
  }

  console.log(
    `[backfill-mime] ${args.apply ? "APPLY" : "DRY RUN"} — scanning ${usersDir}\n`,
  );

  let totals = { corrected: 0, skippedDeleted: 0, alreadyOk: 0, stores: 0 };
  for (const userEntry of await readdir(usersDir, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) continue;
    const registryPath = join(usersDir, userEntry.name, "files", "registry.jsonl");
    if (!existsSync(registryPath)) continue;
    totals.stores++;
    console.log(`[backfill-mime] ${userEntry.name}`);
    const r = await backfillStore(registryPath, args.apply);
    totals.corrected += r.corrected;
    totals.skippedDeleted += r.skippedDeleted;
    totals.alreadyOk += r.alreadyOk;
  }

  console.log(
    `\n[backfill-mime] done. stores=${totals.stores} ` +
      `${args.apply ? "corrected" : "would correct"}=${totals.corrected} ` +
      `alreadyOk=${totals.alreadyOk} skippedDeleted=${totals.skippedDeleted}`,
  );
  if (!args.apply && totals.corrected > 0) {
    console.log("[backfill-mime] re-run with --apply to write these corrections.");
  }
}

main().catch((err) => {
  console.error("[backfill-mime] FATAL:", err);
  process.exit(1);
});
