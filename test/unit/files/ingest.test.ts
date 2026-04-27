import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileStore } from "../../../src/files/store.ts";
import { ingestFiles, type UploadedFile } from "../../../src/files/ingest.ts";
import type { FileConfig } from "../../../src/files/types.ts";

const DEFAULT_CONFIG: FileConfig = {
  maxFileSize: 26_214_400,
  maxTotalSize: 104_857_600,
  maxFilesPerMessage: 10,
  maxExtractedTextSize: 204_800,
};

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-ingest-"));
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

describe("ingestFiles", () => {
  test("text file produces extracted text content part", async () => {
    const store = createFileStore(join(workDir, "files"));
    const files = [makeFile("hello world", "test.txt", "text/plain")];
    const result = await ingestFiles(files, "conv_1", store, DEFAULT_CONFIG);

    expect(result.errors).toHaveLength(0);
    expect(result.fileRefs).toHaveLength(1);
    expect(result.fileRefs[0].extracted).toBe(true);

    const textParts = result.contentParts.filter((p) => p.type === "text");
    const extractedPart = textParts.find(
      (p) => p.type === "text" && p.text.includes("hello world"),
    );
    expect(extractedPart).toBeDefined();
  });

  test("text file with charset parameter still hits the extraction path", async () => {
    // Regression: isAllowedMime, isExtractable and isImage must all
    // see the bare MIME. A pre-fix bug accepted `text/plain;charset=utf-8`
    // at the gate but skipped extraction because the classifier did an
    // exact-Set lookup against the parameter-suffixed value.
    const store = createFileStore(join(workDir, "files"));
    const files = [makeFile("charset content", "with-charset.txt", "text/plain;charset=utf-8")];
    const result = await ingestFiles(files, "conv_1", store, DEFAULT_CONFIG);

    expect(result.errors).toHaveLength(0);
    expect(result.fileRefs).toHaveLength(1);
    expect(result.fileRefs[0].extracted).toBe(true);

    const extractedPart = result.contentParts.find(
      (p) => p.type === "text" && p.text.includes("charset content"),
    );
    expect(extractedPart).toBeDefined();
  });

  test("image file produces image content part + metadata notice", async () => {
    const store = createFileStore(join(workDir, "files"));
    const pngHeader = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const files = [makeFile(pngHeader, "photo.png", "image/png")];
    const result = await ingestFiles(files, "conv_1", store, DEFAULT_CONFIG);

    expect(result.errors).toHaveLength(0);
    expect(result.fileRefs).toHaveLength(1);
    expect(result.fileRefs[0].extracted).toBe(false);

    const imagePart = result.contentParts.find((p) => p.type === "image");
    expect(imagePart).toBeDefined();

    const metaPart = result.contentParts.find(
      (p) => p.type === "text" && p.text.includes("photo.png"),
    );
    expect(metaPart).toBeDefined();
  });

  test("binary file (zip) produces metadata-only notice", async () => {
    const store = createFileStore(join(workDir, "files"));
    const files = [makeFile("fake zip data", "archive.zip", "application/zip")];
    const result = await ingestFiles(files, "conv_1", store, DEFAULT_CONFIG);

    expect(result.errors).toHaveLength(0);
    expect(result.fileRefs).toHaveLength(1);
    expect(result.fileRefs[0].extracted).toBe(false);

    const noticePart = result.contentParts.find(
      (p) =>
        p.type === "text" &&
        p.text.includes("binary file") &&
        p.text.includes("files__read"),
    );
    expect(noticePart).toBeDefined();
  });

  test("rejects when file count exceeds limit", async () => {
    const store = createFileStore(join(workDir, "files"));
    const config: FileConfig = { ...DEFAULT_CONFIG, maxFilesPerMessage: 2 };
    const files = [
      makeFile("a", "a.txt", "text/plain"),
      makeFile("b", "b.txt", "text/plain"),
      makeFile("c", "c.txt", "text/plain"),
    ];
    const result = await ingestFiles(files, "conv_1", store, config);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Too many files");
    expect(result.fileRefs).toHaveLength(0);
  });

  test("rejects when individual file exceeds size limit", async () => {
    const store = createFileStore(join(workDir, "files"));
    const config: FileConfig = { ...DEFAULT_CONFIG, maxFileSize: 10 };
    const files = [makeFile("this is longer than 10 bytes", "big.txt", "text/plain")];
    const result = await ingestFiles(files, "conv_1", store, config);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("exceeds limit");
    expect(result.fileRefs).toHaveLength(0);
  });

  test("rejects when total size exceeds limit", async () => {
    const store = createFileStore(join(workDir, "files"));
    const config: FileConfig = { ...DEFAULT_CONFIG, maxTotalSize: 10 };
    const files = [makeFile("this is longer than 10 bytes", "big.txt", "text/plain")];
    const result = await ingestFiles(files, "conv_1", store, config);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Total file size");
    expect(result.fileRefs).toHaveLength(0);
  });

  test("rejects disallowed MIME type", async () => {
    const store = createFileStore(join(workDir, "files"));
    const files = [makeFile("#!/bin/bash", "evil.sh", "application/x-executable")];
    const result = await ingestFiles(files, "conv_1", store, DEFAULT_CONFIG);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("disallowed type");
    expect(result.fileRefs).toHaveLength(0);
  });

  test("multiple files produce correctly ordered content parts", async () => {
    const store = createFileStore(join(workDir, "files"));
    const files = [
      makeFile("csv data", "data.csv", "text/csv"),
      makeFile("zip content", "archive.zip", "application/zip"),
    ];
    const result = await ingestFiles(files, "conv_1", store, DEFAULT_CONFIG);

    expect(result.errors).toHaveLength(0);
    expect(result.fileRefs).toHaveLength(2);
    expect(result.contentParts.length).toBeGreaterThanOrEqual(2);
  });

  test("each ingested file gets a registry entry with source chat", async () => {
    const store = createFileStore(join(workDir, "files"));
    const files = [makeFile("hello", "test.txt", "text/plain")];
    await ingestFiles(files, "conv_42", store, DEFAULT_CONFIG);

    const registry = await store.readRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0].source).toBe("chat");
    expect(registry[0].conversationId).toBe("conv_42");
    expect(registry[0].filename).toBe("test.txt");
  });

  test("extraction failure for one file does not block others", async () => {
    const store = createFileStore(join(workDir, "files"));
    // A PDF with invalid content will fail extraction but should still be stored
    const files = [
      makeFile("not a real pdf", "broken.pdf", "application/pdf"),
      makeFile("good text", "good.txt", "text/plain"),
    ];
    const result = await ingestFiles(files, "conv_1", store, DEFAULT_CONFIG);

    expect(result.errors).toHaveLength(0);
    expect(result.fileRefs).toHaveLength(2);
    // The broken PDF should be stored but not extracted
    expect(result.fileRefs[0].extracted).toBe(false);
    // The good text should be extracted
    expect(result.fileRefs[1].extracted).toBe(true);
  });

  test("JSON file is extractable", async () => {
    const store = createFileStore(join(workDir, "files"));
    const files = [
      makeFile('{"key": "value"}', "config.json", "application/json"),
    ];
    const result = await ingestFiles(files, "conv_1", store, DEFAULT_CONFIG);

    expect(result.fileRefs[0].extracted).toBe(true);
    const textPart = result.contentParts.find(
      (p) => p.type === "text" && p.text.includes('"key"'),
    );
    expect(textPart).toBeDefined();
  });
});
