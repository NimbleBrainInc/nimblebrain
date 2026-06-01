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
    const store = createFileStore(join(workDir, "files"));
    const data = Buffer.from("hello world");
    const result = await store.saveFile(data, "test.txt", "text/plain");

    expect(result.id).toMatch(/^fl_/);
    expect(result.size).toBe(11);
    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toContain("test.txt");
  });

  test("readFile returns the same bytes written", async () => {
    const store = createFileStore(join(workDir, "files"));
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
    const store = createFileStore(join(workDir, "files"));
    const saved = await store.saveFile(Buffer.from("x"), "doc.pdf", "application/pdf");
    const resolved = await store.resolveFilePath(saved.id);
    expect(resolved).toBe(saved.path);
  });

  test("resolveFilePath throws for IDs that would escape the files directory", async () => {
    const store = createFileStore(join(workDir, "files"));
    await store.ensureFilesDir();
    expect(store.resolveFilePath("../../etc/passwd")).rejects.toThrow();
  });

  test("resolveFilePath throws for non-existent IDs", async () => {
    const store = createFileStore(join(workDir, "files"));
    await store.ensureFilesDir();
    expect(store.resolveFilePath("fl_nonexistent")).rejects.toThrow("File not found");
  });

  test("appendRegistry creates registry.jsonl if missing", async () => {
    const store = createFileStore(join(workDir, "files"));
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
    const store = createFileStore(join(workDir, "files"));

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
    const store = createFileStore(join(workDir, "files"));
    const entries = await store.readRegistry();
    expect(entries).toEqual([]);
  });

  test("appendTombstone refuses to create a stub for an unknown id", async () => {
    const store = createFileStore(join(workDir, "files"));
    await store.ensureFilesDir();
    expect(store.appendTombstone("fl_nonexistent")).rejects.toThrow("File not found");
  });

  test("deleteFile is a no-op for an unknown id — no zombie registry entry", async () => {
    const store = createFileStore(join(workDir, "files"));
    await store.ensureFilesDir();
    await store.deleteFile("fl_nonexistent");
    const entries = await store.readRegistry();
    expect(entries).toEqual([]);
  });

  test("readFile throws File not found when the registry has no entry", async () => {
    const store = createFileStore(join(workDir, "files"));
    const orphanId = `fl_${"a".repeat(24)}`;
    await store.ensureFilesDir();
    // Drop a stray disk file matching the id prefix, but don't register it.
    // Pre-fix, readFile silently returned it with an octet-stream mimeType.
    const filePath = join(workDir, "files", `${orphanId}_stray.bin`);
    await (await import("node:fs/promises")).writeFile(filePath, "stray");
    expect(store.readFile(orphanId)).rejects.toThrow(`File not found: ${orphanId}`);
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

describe("FileStore — read-time MIME recovery", () => {
  // A text/source file uploaded before ingest-time recovery existed is stored
  // as application/octet-stream and is unreadable by every text path. The read
  // accessors re-derive a text type from the filename so it reads back without
  // a migration. See `withResolvedMime` in store.ts.
  async function registerOctetStream(
    store: ReturnType<typeof createFileStore>,
    filename: string,
  ): Promise<string> {
    const saved = await store.saveFile(Buffer.from("= Heading\n"), filename, "text/plain");
    const entry: FileEntry = {
      id: saved.id,
      filename,
      // The bug: stored as opaque binary despite being text.
      mimeType: "application/octet-stream",
      size: saved.size,
      tags: [],
      source: "chat",
      conversationId: null,
      createdAt: new Date().toISOString(),
      description: null,
    };
    await store.appendRegistry(entry);
    return saved.id;
  }

  test("findEntry recovers a text type for a .typ stored as octet-stream", async () => {
    const store = createFileStore(join(workDir, "files"));
    const id = await registerOctetStream(store, "engagement-plan.typ");
    const entry = await store.findEntry(id);
    expect(entry?.mimeType).toBe("text/plain");
  });

  test("readFile recovers the type so bytes come back as text", async () => {
    const store = createFileStore(join(workDir, "files"));
    const id = await registerOctetStream(store, "engagement-plan.typ");
    const read = await store.readFile(id);
    expect(read.mimeType).toBe("text/plain");
    expect(read.data.toString("utf-8")).toBe("= Heading\n");
  });

  test("readRegistry recovers the type for list/search consumers", async () => {
    const store = createFileStore(join(workDir, "files"));
    await registerOctetStream(store, "report.md");
    const [entry] = await store.readRegistry();
    expect(entry.mimeType).toBe("text/markdown");
  });

  test("genuine binary with an unmapped extension stays octet-stream", async () => {
    const store = createFileStore(join(workDir, "files"));
    const id = await registerOctetStream(store, "payload.bin");
    const entry = await store.findEntry(id);
    expect(entry?.mimeType).toBe("application/octet-stream");
  });

  test("a specific stored type is never overridden", async () => {
    const store = createFileStore(join(workDir, "files"));
    const saved = await store.saveFile(Buffer.from("x"), "photo.png", "image/png");
    await store.appendRegistry({
      id: saved.id,
      filename: "photo.png",
      mimeType: "image/png",
      size: saved.size,
      tags: [],
      source: "chat",
      conversationId: null,
      createdAt: new Date().toISOString(),
      description: null,
    });
    const entry = await store.findEntry(saved.id);
    expect(entry?.mimeType).toBe("image/png");
  });

  test("recovery never resurrects a deleted file", async () => {
    const store = createFileStore(join(workDir, "files"));
    const id = await registerOctetStream(store, "deleted.typ");
    await store.deleteFile(id);
    expect(await store.findEntry(id)).toBeNull();
    expect(await store.readRegistry()).toHaveLength(0);
  });
});
