import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileStore } from "../../../src/files/store.ts";
import { ingestFiles, type UploadedFile } from "../../../src/files/ingest.ts";
import type { FileConfig, FileEntry } from "../../../src/files/types.ts";

const DEFAULT_CONFIG: FileConfig = {
  maxFileSize: 26_214_400,
  maxTotalSize: 104_857_600,
  maxFilesPerMessage: 10,
  maxExtractedTextSize: 204_800,
};

const WS = "ws_test";
const OWNER = "owner_test";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-integration-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeFile(
  content: string | Buffer,
  filename: string,
  mimeType: string,
): UploadedFile {
  return {
    data: typeof content === "string" ? Buffer.from(content) : content,
    filename,
    mimeType,
  };
}

describe("Integration: upload text file → ingest → verify extracted content", () => {
  test("text file is ingested, extracted, and registered", async () => {
    const store = createFileStore(join(workDir, "files"));
    const textContent = "The quick brown fox jumps over the lazy dog.";
    const files = [makeFile(textContent, "notes.txt", "text/plain")];

    const result = await ingestFiles(files, "conv_int_1", store, DEFAULT_CONFIG, WS, OWNER);

    // No errors
    expect(result.errors).toHaveLength(0);

    // One file reference, marked as extracted
    expect(result.fileRefs).toHaveLength(1);
    expect(result.fileRefs[0].extracted).toBe(true);
    expect(result.fileRefs[0].filename).toBe("notes.txt");
    expect(result.fileRefs[0].mimeType).toBe("text/plain");

    // Content parts contain the extracted text
    const textParts = result.contentParts.filter((p) => p.type === "text");
    const extractedPart = textParts.find(
      (p) => p.type === "text" && p.text.includes(textContent),
    );
    expect(extractedPart).toBeDefined();

    // Registry has the entry
    const registry = await store.readRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].filename).toBe("notes.txt");
    expect(registry[0].source).toBe("chat");
    expect(registry[0].conversationId).toBe("conv_int_1");
  });
});

describe("Integration: upload PNG image → ingest → verify resource_link content part", () => {
  test("image file produces a resource_link content part referencing the file store", async () => {
    const store = createFileStore(join(workDir, "files"));
    // Minimal PNG header bytes
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const files = [makeFile(pngHeader, "screenshot.png", "image/png")];

    const result = await ingestFiles(files, "conv_int_2", store, DEFAULT_CONFIG, WS, OWNER);

    expect(result.errors).toHaveLength(0);
    expect(result.fileRefs).toHaveLength(1);
    expect(result.fileRefs[0].extracted).toBe(false);
    expect(result.fileRefs[0].mimeType).toBe("image/png");

    // Bytes are persisted in the FileStore; the message content carries
    // an MCP `resource_link` block referencing them by `files://<id>` URI.
    const linkPart = result.contentParts.find((p) => p.type === "resource_link");
    expect(linkPart).toBeDefined();
    if (linkPart && linkPart.type === "resource_link") {
      expect(linkPart.uri).toBe(`files://${result.fileRefs[0].id}`);
      expect(linkPart.mimeType).toBe("image/png");
      expect(linkPart.name).toBe("screenshot.png");
    }
  });
});

describe("Integration: upload PDF → ingest → verify resource_link without extracted text", () => {
  test("PDF file produces a resource_link content part and skips prompt text extraction", async () => {
    const store = createFileStore(join(workDir, "files"));
    const files = [makeFile(Buffer.from("%PDF-1.4\n%%EOF"), "report.pdf", "application/pdf")];

    const result = await ingestFiles(files, "conv_int_pdf", store, DEFAULT_CONFIG, WS, OWNER);

    expect(result.errors).toHaveLength(0);
    expect(result.fileRefs).toHaveLength(1);
    expect(result.fileRefs[0].extracted).toBe(false);
    expect(result.fileRefs[0].mimeType).toBe("application/pdf");
    expect(result.contentParts.filter((p) => p.type === "text")).toHaveLength(0);

    const linkPart = result.contentParts.find((p) => p.type === "resource_link");
    expect(linkPart).toBeDefined();
    if (linkPart && linkPart.type === "resource_link") {
      expect(linkPart.uri).toBe(`files://${result.fileRefs[0].id}`);
      expect(linkPart.mimeType).toBe("application/pdf");
      expect(linkPart.name).toBe("report.pdf");
    }
  });
});

describe("Integration: backward compat — no files → empty result", () => {
  test("empty files array returns empty contentParts, fileRefs, and no errors", async () => {
    const store = createFileStore(join(workDir, "files"));

    const result = await ingestFiles([], "conv_int_3", store, DEFAULT_CONFIG, WS, OWNER);

    expect(result.contentParts).toHaveLength(0);
    expect(result.fileRefs).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe("Integration: FileStore save → registry → read round-trip", () => {
  test("file saved via FileStore can be read back with matching bytes", async () => {
    const store = createFileStore(join(workDir, "files"));
    const original = Buffer.from("binary payload \x00\x01\x02\xff");

    // Save the file
    const saved = await store.saveFile(original, "payload.bin", "application/octet-stream");
    expect(saved.id).toMatch(/^fl_/);
    expect(saved.size).toBe(original.length);

    // Register in the registry
    const entry: FileEntry = {
      id: saved.id,
      workspaceId: WS,
      ownerId: OWNER,
      filename: "payload.bin",
      mimeType: "application/octet-stream",
      size: saved.size,
      tags: ["test"],
      source: "manual",
      conversationId: null,
      createdAt: new Date().toISOString(),
      description: "test payload",
    };
    await store.appendRegistry(entry);

    // Verify registry lists it
    const registry = await store.readRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].id).toBe(saved.id);
    expect(registry[0].filename).toBe("payload.bin");

    // Read back via FileStore
    const read = await store.readFile(saved.id);
    expect(Buffer.compare(read.data, original)).toBe(0);
    expect(read.filename).toBe("payload.bin");
    expect(read.mimeType).toBe("application/octet-stream");
    expect(read.size).toBe(original.length);
  });
});

describe("Integration: files bundle write → read round-trip (filesystem)", () => {
  test("file written to {workDir}/files/ with registry entry can be read back", async () => {
    const filesDir = join(workDir, "files");
    await mkdir(filesDir, { recursive: true });

    const registryPath = join(filesDir, "registry.jsonl");
    const fileId = "fl_test_roundtrip";
    const filename = "document.md";
    const content = Buffer.from("# Hello World\n\nThis is a markdown document.");

    // Write file to disk (mimicking bundle write)
    const diskName = `${fileId}_${filename}`;
    await writeFile(join(filesDir, diskName), content);

    // Append registry entry (mimicking bundle registry append)
    const entry: FileEntry = {
      id: fileId,
      workspaceId: WS,
      ownerId: OWNER,
      filename,
      mimeType: "text/markdown",
      size: content.length,
      tags: [],
      source: "manual",
      conversationId: null,
      createdAt: new Date().toISOString(),
      description: null,
    };
    await appendFile(registryPath, JSON.stringify(entry) + "\n");

    // Read back via FileStore to verify interoperability
    const store = createFileStore(join(workDir, "files"));
    const registry = await store.readRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].id).toBe(fileId);

    // Read file content directly from disk
    const readBack = await readFile(join(filesDir, diskName));
    expect(Buffer.compare(readBack, content)).toBe(0);
  });
});

describe("Integration: files bundle search by filename", () => {
  test("filtering registry by filename substring finds correct matches", async () => {
    const store = createFileStore(join(workDir, "files"));

    const entries: FileEntry[] = [
      {
        id: "fl_alpha",
        workspaceId: WS,
        ownerId: OWNER,
        filename: "quarterly-report.pdf",
        mimeType: "application/pdf",
        size: 100,
        tags: ["report"],
        source: "manual",
        conversationId: null,
        createdAt: "2026-01-01T00:00:00Z",
        description: null,
      },
      {
        id: "fl_beta",
        workspaceId: WS,
        ownerId: OWNER,
        filename: "meeting-notes.txt",
        mimeType: "text/plain",
        size: 50,
        tags: ["notes"],
        source: "manual",
        conversationId: null,
        createdAt: "2026-01-02T00:00:00Z",
        description: null,
      },
      {
        id: "fl_gamma",
        workspaceId: WS,
        ownerId: OWNER,
        filename: "annual-report.pdf",
        mimeType: "application/pdf",
        size: 200,
        tags: ["report"],
        source: "manual",
        conversationId: null,
        createdAt: "2026-01-03T00:00:00Z",
        description: null,
      },
    ];

    for (const entry of entries) {
      await store.appendRegistry(entry);
    }

    // Search by substring "report"
    const registry = await store.readRegistry();
    const matches = registry.filter((e) =>
      e.filename.toLowerCase().includes("report"),
    );

    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.id).sort()).toEqual(["fl_alpha", "fl_gamma"]);
  });
});

describe("Integration: files bundle delete (tombstone)", () => {
  test("tombstoned file is excluded from registry read", async () => {
    const store = createFileStore(join(workDir, "files"));

    const entry: FileEntry = {
      id: "fl_to_delete",
      workspaceId: WS,
      ownerId: OWNER,
      filename: "temp.txt",
      mimeType: "text/plain",
      size: 10,
      tags: [],
      source: "manual",
      conversationId: null,
      createdAt: new Date().toISOString(),
      description: null,
    };
    await store.appendRegistry(entry);

    // Verify it exists
    let registry = await store.readRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].id).toBe("fl_to_delete");

    // Tombstone it
    await store.appendTombstone("fl_to_delete");

    // Verify it is excluded
    registry = await store.readRegistry();
    expect(registry).toHaveLength(0);
  });
});

describe("Integration: validation — reject oversized file", () => {
  test("file exceeding maxFileSize is rejected with error", async () => {
    const store = createFileStore(join(workDir, "files"));
    const config: FileConfig = { ...DEFAULT_CONFIG, maxFileSize: 16 };

    const files = [
      makeFile("this content is definitely longer than sixteen bytes", "big.txt", "text/plain"),
    ];

    const result = await ingestFiles(files, "conv_int_v1", store, config, WS, OWNER);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("exceeds limit");
    expect(result.fileRefs).toHaveLength(0);
    expect(result.contentParts).toHaveLength(0);
  });
});

describe("Integration: validation — reject disallowed MIME type", () => {
  test("application/x-executable is rejected with error", async () => {
    const store = createFileStore(join(workDir, "files"));
    const files = [
      makeFile("#!/bin/bash\nrm -rf /", "malicious.exe", "application/x-executable"),
    ];

    const result = await ingestFiles(files, "conv_int_v2", store, DEFAULT_CONFIG, WS, OWNER);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("disallowed type");
    expect(result.fileRefs).toHaveLength(0);
    expect(result.contentParts).toHaveLength(0);
  });
});
