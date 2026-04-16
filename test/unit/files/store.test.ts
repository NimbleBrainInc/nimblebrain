import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileStore, sanitizeFilename } from "../../../src/files/store.ts";
import type { FileEntry } from "../../../src/files/types.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-filestore-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("FileStore", () => {
  test("saveFile creates a file on disk with correct naming", async () => {
    const store = createFileStore(workDir);
    const data = Buffer.from("hello world");
    const result = await store.saveFile(data, "test.txt", "text/plain");

    expect(result.id).toMatch(/^fl_/);
    expect(result.size).toBe(11);
    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toContain("test.txt");
  });

  test("readFile returns the same bytes written", async () => {
    const store = createFileStore(workDir);
    const original = Buffer.from("binary content \x00\xff");
    const saved = await store.saveFile(original, "data.bin", "application/octet-stream");

    // Register so readFile can look up mimeType
    const entry: FileEntry = {
      id: saved.id,
      filename: "data.bin",
      mimeType: "application/octet-stream",
      size: saved.size,
      tags: [],
      source: "manual",
      conversationId: null,
      createdAt: new Date().toISOString(),
      description: null,
    };
    await store.appendRegistry(entry);

    const read = await store.readFile(saved.id);
    expect(Buffer.compare(read.data, original)).toBe(0);
    expect(read.filename).toBe("data.bin");
    expect(read.mimeType).toBe("application/octet-stream");
    expect(read.size).toBe(original.length);
  });

  test("resolveFilePath returns correct path for valid ID", async () => {
    const store = createFileStore(workDir);
    const saved = await store.saveFile(Buffer.from("x"), "doc.pdf", "application/pdf");
    const resolved = await store.resolveFilePath(saved.id);
    expect(resolved).toBe(saved.path);
  });

  test("resolveFilePath throws for IDs that would escape the files directory", async () => {
    const store = createFileStore(workDir);
    await store.ensureFilesDir();
    expect(store.resolveFilePath("../../etc/passwd")).rejects.toThrow();
  });

  test("resolveFilePath throws for non-existent IDs", async () => {
    const store = createFileStore(workDir);
    await store.ensureFilesDir();
    expect(store.resolveFilePath("fl_nonexistent")).rejects.toThrow("File not found");
  });

  test("appendRegistry creates registry.jsonl if missing", async () => {
    const store = createFileStore(workDir);
    const entry: FileEntry = {
      id: "fl_test_001",
      filename: "hello.txt",
      mimeType: "text/plain",
      size: 5,
      tags: [],
      source: "manual",
      conversationId: null,
      createdAt: new Date().toISOString(),
      description: null,
    };
    await store.appendRegistry(entry);

    const registryPath = join(workDir, "files", "registry.jsonl");
    expect(existsSync(registryPath)).toBe(true);

    const content = readFileSync(registryPath, "utf-8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.id).toBe("fl_test_001");
    expect(parsed.filename).toBe("hello.txt");
  });

  test("readRegistry returns entries, excludes tombstoned entries", async () => {
    const store = createFileStore(workDir);

    const entry1: FileEntry = {
      id: "fl_a",
      filename: "a.txt",
      mimeType: "text/plain",
      size: 1,
      tags: [],
      source: "manual",
      conversationId: null,
      createdAt: new Date().toISOString(),
      description: null,
    };
    const entry2: FileEntry = {
      id: "fl_b",
      filename: "b.txt",
      mimeType: "text/plain",
      size: 2,
      tags: [],
      source: "manual",
      conversationId: null,
      createdAt: new Date().toISOString(),
      description: null,
    };

    await store.appendRegistry(entry1);
    await store.appendRegistry(entry2);
    await store.appendTombstone("fl_a");

    const entries = await store.readRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("fl_b");
  });

  test("readRegistry returns empty array when no registry exists", async () => {
    const store = createFileStore(workDir);
    const entries = await store.readRegistry();
    expect(entries).toEqual([]);
  });
});

describe("sanitizeFilename", () => {
  test("strips path separators", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitizeFilename("folder\\file.txt")).toBe("folderfile.txt");
  });

  test("strips null bytes and control chars", () => {
    expect(sanitizeFilename("file\x00name\x01.txt")).toBe("filename.txt");
  });

  test("preserves unicode filenames", () => {
    expect(sanitizeFilename("レポート.pdf")).toBe("レポート.pdf");
    expect(sanitizeFilename("文档 备份.docx")).toBe("文档 备份.docx");
    expect(sanitizeFilename("naïve café.txt")).toBe("naïve café.txt");
  });

  test("returns 'unnamed' for empty result", () => {
    expect(sanitizeFilename("///")).toBe("unnamed");
    expect(sanitizeFilename("\x00\x01")).toBe("unnamed");
  });
});
