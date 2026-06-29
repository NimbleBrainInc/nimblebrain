import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { resolveMimeType } from "./mime.ts";
import { parseFilePath } from "./paths.ts";
import type { ExtractedTextSidecar, FileEntry } from "./types.ts";

/**
 * Recover a usable MIME type for an entry whose stored type is empty or the
 * generic `application/octet-stream`. Mirrors the ingest-time recovery in
 * `resolveMimeType` (the three mint sites) but at the READ seam, so files
 * written before that fix — stored as opaque binary and therefore unreadable
 * by every text path (`extractText`, `isExtractable`, `files://` delivery,
 * the REST download `Content-Type`, chat rehydration) — become readable with
 * no migration required.
 *
 * Recovery is MONOTONIC: `resolveMimeType` only ever turns a generic/empty
 * type into a text type for a known text/source extension (its EXTENSION_MIME
 * invariant); a specific stored type is returned verbatim. So real binary
 * (`.bin`, images, PDFs, archives) is never mislabelled, and re-applying it is
 * idempotent. Applied at `findEntry` and `readRegistry` (and thus
 * `readFileById`, which reads through `findEntry`) so every reader agrees on
 * one type. Mutations that read-then-re-append (`tag`, `delete`) persist the
 * corrected type — an intended, idempotent lazy backfill.
 */
function withResolvedMime(entry: FileEntry): FileEntry {
  const resolved = resolveMimeType(entry.filename, entry.mimeType);
  return resolved === entry.mimeType ? entry : { ...entry, mimeType: resolved };
}

/** Sanitize a filename: strip path separators, null bytes, and control chars (0x00-0x1F). */
export function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[/\\]/g, "")
      .replace(/\0/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional filename sanitization
      .replace(/[\x00-\x1f]/g, "")
      .trim() || "unnamed"
  );
}

/** Generate a file ID with fl_ prefix. 24 hex chars (~96 bits random). */
function generateFileId(): string {
  return `fl_${randomBytes(12).toString("hex")}`;
}

export interface SaveFileResult {
  id: string;
  path: string;
  size: number;
}

export interface ReadFileResult {
  data: Buffer;
  filename: string;
  mimeType: string;
  size: number;
}

export interface FileStore {
  saveFile(data: Buffer, filename: string, mimeType: string): Promise<SaveFileResult>;
  readFile(id: string): Promise<ReadFileResult>;
  resolveFilePath(id: string): Promise<string>;
  appendRegistry(entry: FileEntry): Promise<void>;
  readRegistry(): Promise<FileEntry[]>;
  findEntry(id: string): Promise<FileEntry | null>;
  appendTombstone(id: string): Promise<void>;
  deleteFile(id: string): Promise<void>;
  ensureFilesDir(): Promise<void>;
  /**
   * Read the extracted-text sidecar for `id`. Returns null if the sidecar
   * is missing or unreadable. Callers decide invalidation by comparing
   * `maxSize` against their current config.
   */
  readExtractedText(id: string): Promise<ExtractedTextSidecar | null>;
  /** Write (or overwrite) the extracted-text sidecar for `id`. */
  writeExtractedText(id: string, sidecar: ExtractedTextSidecar): Promise<void>;
}

/**
 * Create a file store rooted at `filesDir`.
 *
 * Files are workspace-owned: `filesDir` is a resolved, workspace-partitioned
 * path (`workspaces/<wsId>/files/<ownerId>/`; see `src/files/paths.ts`).
 * Construct it only through `Runtime.getFileStore(wsId, ownerId)` — the single
 * sanctioned path, enforced by `check:file-paths`.
 *
 * The store derives its scope from the path (`parseFilePath`): the directory is
 * authoritative for `workspaceId` + `ownerId` (§2.3). On read, entries that
 * lack those fields — legacy rows migrated by a pure move — are backfilled from
 * the path so they self-heal without a registry rewrite. `null` for a path that
 * isn't workspace-partitioned (e.g. a unit-test scratch dir) just disables the
 * backfill.
 */
export function createFileStore(filesDir: string): FileStore {
  const registryPath = join(filesDir, "registry.jsonl");
  const scope = parseFilePath(filesDir);

  /**
   * Backfill the path-authoritative scope onto an entry whose `ownerId` /
   * `workspaceId` are absent (a migrated legacy row). `visibility` is left
   * alone — absent reads as `private`, and nothing consults it in v1.
   */
  function withScope(entry: FileEntry): FileEntry {
    if (!scope) return entry;
    if (entry.ownerId && entry.workspaceId) return entry;
    return {
      ...entry,
      ownerId: entry.ownerId || scope.ownerId,
      workspaceId: entry.workspaceId || scope.wsId,
    };
  }

  async function ensureFilesDir(): Promise<void> {
    await mkdir(filesDir, { recursive: true });
  }

  async function saveFile(
    data: Buffer,
    filename: string,
    _mimeType: string,
  ): Promise<SaveFileResult> {
    await ensureFilesDir();
    const id = generateFileId();
    const sanitized = sanitizeFilename(filename);
    const diskName = `${id}_${sanitized}`;
    const filePath = join(filesDir, diskName);
    await writeFile(filePath, data);
    return { id, path: filePath, size: data.length };
  }

  async function resolveFilePath(id: string): Promise<string> {
    await ensureFilesDir();
    const entries = await readdir(filesDir);
    const match = entries.find((e) => e.startsWith(`${id}_`));
    if (!match) {
      throw new Error(`File not found: ${id}`);
    }
    const resolved = resolve(filesDir, match);
    // Defence against a constructed `id` that contains path segments — in
    // practice `match` always comes from `readdir(filesDir)` so can't
    // traverse, but a `startsWith` guard would false-positive on sibling
    // dirs sharing a prefix (e.g. `/ws/files` vs `/ws/filesX`). `relative`
    // + `..` gives a clean invariant.
    const rel = relative(resolve(filesDir), resolved);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      throw new Error("Path traversal detected");
    }
    return resolved;
  }

  async function readFileById(id: string): Promise<ReadFileResult> {
    const entry = await findEntry(id);
    if (!entry) {
      throw new Error(`File not found: ${id}`);
    }
    const filePath = await resolveFilePath(id);
    const data = Buffer.from(await readFile(filePath));
    const diskName = basename(filePath);
    const filename = diskName.slice(id.length + 1);
    return { data, filename, mimeType: entry.mimeType, size: data.length };
  }

  async function appendRegistry(entry: FileEntry): Promise<void> {
    await ensureFilesDir();
    await appendFile(registryPath, `${JSON.stringify(entry)}\n`);
  }

  async function readRegistryRaw(): Promise<FileEntry[]> {
    let content: string;
    try {
      content = await readFile(registryPath, "utf-8");
    } catch {
      return [];
    }
    const entries: FileEntry[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as FileEntry);
      } catch {
        // Skip malformed lines rather than refusing to read the whole registry.
      }
    }
    return entries;
  }

  /**
   * Resolve the registry to the latest state per ID (last-write-wins).
   * Filters out tombstoned entries. Supports both "tag" updates (re-append
   * with new fields) and "delete" (append entry with `deleted: true`).
   */
  async function readRegistry(): Promise<FileEntry[]> {
    const raw = await readRegistryRaw();
    const latest = new Map<string, FileEntry>();
    for (const entry of raw) {
      latest.set(entry.id, entry);
    }
    return Array.from(latest.values())
      .filter((e) => !e.deleted)
      .map(withResolvedMime)
      .map(withScope);
  }

  async function findEntry(id: string): Promise<FileEntry | null> {
    const raw = await readRegistryRaw();
    let found: FileEntry | null = null;
    for (const entry of raw) {
      if (entry.id === id) found = entry;
    }
    if (!found || found.deleted) return null;
    return withScope(withResolvedMime(found));
  }

  /**
   * Append a tombstone marking `id` deleted. Requires the entry to exist;
   * callers must pre-check via `findEntry`. Refuses to create stub
   * tombstones for unknown ids (no `filename: ""` zombies in the
   * registry).
   */
  async function appendTombstone(id: string): Promise<void> {
    const existing = await findEntry(id);
    if (!existing) {
      throw new Error(`File not found: ${id}`);
    }
    await appendRegistry({ ...existing, deleted: true, deletedAt: new Date().toISOString() });
  }

  async function deleteFile(id: string): Promise<void> {
    const existing = await findEntry(id);
    if (!existing) return; // No-op on missing — idempotent delete.
    await appendRegistry({ ...existing, deleted: true, deletedAt: new Date().toISOString() });
    try {
      const path = await resolveFilePath(id);
      await unlink(path);
    } catch {
      // File already gone from disk — tombstone still recorded.
    }
    // Best-effort sidecar cleanup. The sidecar is derived, so a stale
    // copy isn't a correctness issue, but leaving it on disk leaks space.
    try {
      await unlink(extractedSidecarPath(id));
    } catch {
      // Sidecar never existed or already removed.
    }
  }

  function extractedSidecarPath(id: string): string {
    return join(filesDir, `${id}.extracted.json`);
  }

  async function readExtractedText(id: string): Promise<ExtractedTextSidecar | null> {
    try {
      const raw = await readFile(extractedSidecarPath(id), "utf-8");
      const parsed = JSON.parse(raw) as ExtractedTextSidecar;
      if (
        typeof parsed.text !== "string" ||
        typeof parsed.maxSize !== "number" ||
        typeof parsed.truncated !== "boolean"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async function writeExtractedText(id: string, sidecar: ExtractedTextSidecar): Promise<void> {
    await ensureFilesDir();
    await writeFile(extractedSidecarPath(id), JSON.stringify(sidecar));
  }

  return {
    saveFile,
    readFile: readFileById,
    resolveFilePath,
    appendRegistry,
    readRegistry,
    findEntry,
    appendTombstone,
    deleteFile,
    ensureFilesDir,
    readExtractedText,
    writeExtractedText,
  };
}
