import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

/** Generate a file ID with fl_ prefix. */
function generateFileId(): string {
  return `fl_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
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
  appendTombstone(id: string): Promise<void>;
  ensureFilesDir(): Promise<void>;
}

export function createFileStore(workDir: string): FileStore {
  const filesDir = join(workDir, "files");
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
    // Extract filename from disk name: strip the id_ prefix
    const diskName = basename(filePath);
    const filename = diskName.slice(id.length + 1);

    // Look up mimeType from registry
    const registry = await readRegistryRaw();
    const entry = registry.find((e) => e.id === id && !e.deleted);
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
      entries.push(JSON.parse(trimmed) as FileEntry);
    }
    return entries;
  }

  async function readRegistry(): Promise<FileEntry[]> {
    const all = await readRegistryRaw();
    const tombstoned = new Set(all.filter((e) => e.deleted).map((e) => e.id));
    return all.filter((e) => !e.deleted && !tombstoned.has(e.id));
  }

  async function appendTombstone(id: string): Promise<void> {
    const tombstone: FileEntry = {
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

  return {
    saveFile,
    readFile: readFileById,
    resolveFilePath,
    appendRegistry,
    readRegistry,
    appendTombstone,
    ensureFilesDir,
  };
}
