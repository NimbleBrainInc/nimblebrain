import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { FileEntry } from "./types.ts";

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
}

/**
 * Create a workspace-scoped file store.
 *
 * `filesDir` must be a resolved, workspace-scoped path — typically
 * `join(runtime.getWorkspaceScopedDir(wsId), "files")`. Passing a
 * tenant-global path (e.g. `runtime.getWorkDir()`) mixes files across
 * workspaces and is the bug that motivated unifying this store; callers
 * must resolve the workspace-scoped path themselves.
 */
export function createFileStore(filesDir: string): FileStore {
  const registryPath = join(filesDir, "registry.jsonl");

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
    if (!resolved.startsWith(resolve(filesDir))) {
      throw new Error("Path traversal detected");
    }
    return resolved;
  }

  async function readFileById(id: string): Promise<ReadFileResult> {
    const filePath = await resolveFilePath(id);
    const data = Buffer.from(await readFile(filePath));
    const diskName = basename(filePath);
    const filename = diskName.slice(id.length + 1);

    const entry = await findEntry(id);
    const mimeType = entry?.mimeType ?? "application/octet-stream";

    return { data, filename, mimeType, size: data.length };
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
    return Array.from(latest.values()).filter((e) => !e.deleted);
  }

  async function findEntry(id: string): Promise<FileEntry | null> {
    const raw = await readRegistryRaw();
    let found: FileEntry | null = null;
    for (const entry of raw) {
      if (entry.id === id) found = entry;
    }
    if (!found || found.deleted) return null;
    return found;
  }

  async function appendTombstone(id: string): Promise<void> {
    const existing = await findEntry(id);
    const tombstone: FileEntry = existing
      ? { ...existing, deleted: true, deletedAt: new Date().toISOString() }
      : {
          id,
          filename: "",
          mimeType: "",
          size: 0,
          tags: [],
          source: "manual",
          conversationId: null,
          createdAt: new Date().toISOString(),
          description: null,
          deleted: true,
          deletedAt: new Date().toISOString(),
        };
    await appendRegistry(tombstone);
  }

  async function deleteFile(id: string): Promise<void> {
    await appendTombstone(id);
    try {
      const path = await resolveFilePath(id);
      await unlink(path);
    } catch {
      // File already gone from disk — tombstone still recorded.
    }
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
  };
}
