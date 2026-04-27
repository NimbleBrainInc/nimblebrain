import { extractText } from "./extract.ts";
import type { FileStore } from "./store.ts";
import type { ContentPart, FileConfig, FileEntry, FileReference, IngestResult } from "./types.ts";

/** A raw uploaded file from multipart form data. */
export interface UploadedFile {
  data: Buffer;
  filename: string;
  mimeType: string;
}

// MIME types we accept, grouped by category
const EXTRACTABLE_TEXT = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "text/xml",
  "text/yaml",
  "application/json",
  "application/xml",
  "application/yaml",
]);

const EXTRACTABLE_DOCS = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const BINARY_TYPES = new Set([
  "application/zip",
  "application/gzip",
  "font/ttf",
  "font/otf",
  "font/woff",
  "font/woff2",
  "application/octet-stream",
]);

const ALLOWED_MIMES = new Set([
  ...EXTRACTABLE_TEXT,
  ...EXTRACTABLE_DOCS,
  ...IMAGE_TYPES,
  ...BINARY_TYPES,
]);

export function isAllowedMime(mimeType: string): boolean {
  // Browsers (and Bun's Blob) attach parameters like `;charset=utf-8`
  // to the Content-Type. Match the bare type so the allowlist behaves
  // the same regardless of upload origin.
  const bare = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return ALLOWED_MIMES.has(bare);
}

function isExtractable(mimeType: string): boolean {
  return EXTRACTABLE_TEXT.has(mimeType) || EXTRACTABLE_DOCS.has(mimeType);
}

function isImage(mimeType: string): boolean {
  return IMAGE_TYPES.has(mimeType);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Validate and ingest uploaded files into the workspace file store.
 *
 * For each valid file: stores it, registers metadata, extracts text,
 * and builds content parts for the LLM message.
 */
export async function ingestFiles(
  files: UploadedFile[],
  conversationId: string,
  store: FileStore,
  config: FileConfig,
): Promise<IngestResult> {
  const errors: string[] = [];
  const contentParts: ContentPart[] = [];
  const fileRefs: FileReference[] = [];

  // Validate file count
  if (files.length > config.maxFilesPerMessage) {
    errors.push(`Too many files: ${files.length} exceeds limit of ${config.maxFilesPerMessage}`);
    return { contentParts, fileRefs, errors };
  }

  // Validate total size
  const totalSize = files.reduce((sum, f) => sum + f.data.length, 0);
  if (totalSize > config.maxTotalSize) {
    errors.push(
      `Total file size ${humanSize(totalSize)} exceeds limit of ${humanSize(config.maxTotalSize)}`,
    );
    return { contentParts, fileRefs, errors };
  }

  for (const file of files) {
    // Validate individual file size
    if (file.data.length > config.maxFileSize) {
      errors.push(
        `File "${file.filename}" (${humanSize(file.data.length)}) exceeds limit of ${humanSize(config.maxFileSize)}`,
      );
      continue;
    }

    // Validate MIME type
    if (!isAllowedMime(file.mimeType)) {
      errors.push(`File "${file.filename}" has disallowed type: ${file.mimeType}`);
      continue;
    }

    // Store the file
    const saved = await store.saveFile(file.data, file.filename, file.mimeType);

    // Register in registry
    const entry: FileEntry = {
      id: saved.id,
      filename: file.filename,
      mimeType: file.mimeType,
      size: saved.size,
      tags: [],
      source: "chat",
      conversationId,
      createdAt: new Date().toISOString(),
      description: null,
    };
    await store.appendRegistry(entry);

    // Extract text if possible
    let extracted = false;
    if (isExtractable(file.mimeType)) {
      const result = await extractText(file.data, file.mimeType, config.maxExtractedTextSize);
      if (result) {
        extracted = true;
        contentParts.push({
          type: "text",
          text: `--- Attached: ${file.filename} (${saved.id}, ${humanSize(saved.size)}) ---\n${result.text}`,
        });
      }
    }

    // Image files → vision content part
    if (isImage(file.mimeType)) {
      contentParts.push({
        type: "image",
        image: new Uint8Array(file.data),
        mimeType: file.mimeType,
      });
    }

    // Metadata notice (always, for all files)
    if (isImage(file.mimeType)) {
      contentParts.push({
        type: "text",
        text: `[File: ${file.filename} (${saved.id}) — ${humanSize(saved.size)}, ${file.mimeType}]`,
      });
    } else if (!extracted) {
      // Non-extractable, non-image file
      contentParts.push({
        type: "text",
        text: `--- Attached: ${file.filename} (${saved.id}, ${humanSize(saved.size)}) — binary file, use files__read to access ---`,
      });
    }

    // Build file reference for conversation metadata
    fileRefs.push({
      id: saved.id,
      filename: file.filename,
      mimeType: file.mimeType,
      size: saved.size,
      extracted,
    });
  }

  return { contentParts, fileRefs, errors };
}
