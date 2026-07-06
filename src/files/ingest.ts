import { extractText, REHYDRATE_TRUNCATED_SUFFIX } from "./extract.ts";
import type { FileStore, SaveFileResult } from "./store.ts";
import type { ContentPart, FileConfig, FileEntry, FileReference, IngestResult } from "./types.ts";
import { fileIdToUri } from "./uri.ts";

/** A raw uploaded file from multipart form data. */
export interface UploadedFile {
  data: Buffer;
  filename: string;
  mimeType: string;
}

// MIME types we accept, grouped by category. Exported so other modules
// (notably `src/tools/platform/files.ts::handleRead`) classify files
// against the same source of truth instead of duplicating the lists.
export const EXTRACTABLE_TEXT = new Set([
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

export const EXTRACTABLE_DOCS = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

export const PDF_TYPES = new Set(["application/pdf"]);

/**
 * Image MIME types accepted on upload. Exported so the rehydration
 * step (`src/files/rehydrate.ts`) can derive its own (slightly narrower)
 * vision-input set from a single source of truth.
 */
export const IMAGE_TYPES = new Set([
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
  ...PDF_TYPES,
  ...IMAGE_TYPES,
  ...BINARY_TYPES,
]);

/**
 * Strip Content-Type parameters and case-fold so all classification
 * predicates (allowlist + extractable + image) see the same shape.
 * Browsers and Bun's Blob attach `;charset=…`, `;boundary=…` etc., and
 * exact-Set lookups against the raw value silently miss otherwise.
 */
function normalizeMime(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function isAllowedMime(mimeType: string): boolean {
  return ALLOWED_MIMES.has(normalizeMime(mimeType));
}

/**
 * True if `extractText` knows how to surface a textual representation
 * of bytes of this MIME type. PDF is excluded: `rehydrate.ts` and
 * `handleRead` route PDFs through their own (capability-aware) policy,
 * not the generic ingest extraction path, so the set stays focused on
 * formats where the only useful surface to the model is extracted text.
 *
 * Mirrors `isTextMime`'s `text/*` prefix rule: `extractText` UTF-8-decodes
 * any `text/*` type, so the read gate (`files__read`) must admit the same set
 * it can actually extract. Without this, a correctly-typed `text/x-*` source
 * file would pass `isTextMime` inside `extractText` but never reach it,
 * because this predicate gated it out first.
 */
export function isExtractable(mimeType: string): boolean {
  const bare = normalizeMime(mimeType);
  return bare.startsWith("text/") || EXTRACTABLE_TEXT.has(bare) || EXTRACTABLE_DOCS.has(bare);
}

function isImage(mimeType: string): boolean {
  return IMAGE_TYPES.has(normalizeMime(mimeType));
}

function isPdf(mimeType: string): boolean {
  return PDF_TYPES.has(normalizeMime(mimeType));
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/** Per-file ingest outcome: content parts, an optional registry reference, and an optional validation error. */
interface FileIngest {
  parts: ContentPart[];
  ref?: FileReference;
  error?: string;
}

/** Extract a text content part for extractable files, or persist a PDF's text sidecar; returns whether a text part was produced. */
async function extractInto(
  file: UploadedFile,
  saved: SaveFileResult,
  store: FileStore,
  config: FileConfig,
  parts: ContentPart[],
): Promise<boolean> {
  if (isExtractable(file.mimeType)) {
    const result = await extractText(file.data, file.mimeType, config.maxExtractedTextSize);
    if (!result) return false;
    parts.push({
      type: "text",
      text: `--- Attached: ${file.filename} (${saved.id}, ${humanSize(saved.size)}) ---\n${result.text}`,
    });
    return true;
  }
  if (isPdf(file.mimeType)) {
    // Populate the extracted-text sidecar so rehydrate's text-fallback
    // path (historical / unsupported-model / oversize) is O(text read)
    // instead of O(reload bytes + re-run unpdf) on every turn. Uses the
    // rehydrate-suffix variant so a cache hit at rehydrate time
    // produces byte-identical content to a live extraction. Best-effort:
    // a failed extraction here just means rehydrate will retry live.
    const result = await extractText(file.data, file.mimeType, config.maxExtractedTextSize, {
      truncatedSuffix: REHYDRATE_TRUNCATED_SUFFIX,
    });
    if (result) {
      await store.writeExtractedText(saved.id, {
        text: result.text,
        maxSize: config.maxExtractedTextSize,
        truncated: result.truncated,
      });
    }
  }
  return false;
}

/** Validate, store, register, extract, and assemble the content parts + reference for a single uploaded file. */
async function ingestOneFile(
  file: UploadedFile,
  conversationId: string,
  store: FileStore,
  config: FileConfig,
  wsId: string | undefined,
  ownerId: string | undefined,
): Promise<FileIngest> {
  const parts: ContentPart[] = [];

  // Validate individual file size
  if (file.data.length > config.maxFileSize) {
    return {
      parts,
      error: `File "${file.filename}" (${humanSize(file.data.length)}) exceeds limit of ${humanSize(config.maxFileSize)}`,
    };
  }

  // Validate MIME type
  if (!isAllowedMime(file.mimeType)) {
    return { parts, error: `File "${file.filename}" has disallowed type: ${file.mimeType}` };
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
    ...(ownerId ? { ownerId } : {}),
    ...(wsId ? { workspaceId: wsId } : {}),
  };
  await store.appendRegistry(entry);

  // Extract text if possible
  const extracted = await extractInto(file, saved, store, config, parts);

  // Rehydratable files → MCP `resource_link` content part. The runtime
  // turns supported resource links into AI SDK V3 `file` parts (with bytes
  // loaded from the FileStore) at the `model.doStream` boundary, so binary
  // content survives multi-turn agentic loops without the conversation log
  // carrying bytes or extracted PDF text inline.
  if (isImage(file.mimeType) || isPdf(file.mimeType)) {
    parts.push({
      type: "resource_link",
      uri: fileIdToUri(saved.id),
      mimeType: file.mimeType,
      name: file.filename,
    });
  } else if (!extracted) {
    // Non-extractable, non-image file. Surface a text hint so the model
    // knows what's attached and can call `files__read` if it needs the
    // bytes. (Extractable files already inserted their content above;
    // images are addressable via the `resource_link` block.)
    parts.push({
      type: "text",
      text: `--- Attached: ${file.filename} (${saved.id}, ${humanSize(saved.size)}) — binary file, use files__read to access ---`,
    });
  }

  // Build file reference for conversation metadata
  return {
    parts,
    ref: {
      id: saved.id,
      filename: file.filename,
      mimeType: file.mimeType,
      size: saved.size,
      extracted,
    },
  };
}

/**
 * Validate and ingest uploaded files into the workspace file store.
 *
 * For each valid file: stores it, registers metadata, extracts text when
 * applicable, and builds content parts for the LLM message.
 */
export async function ingestFiles(
  files: UploadedFile[],
  conversationId: string,
  store: FileStore,
  config: FileConfig,
  // The workspace/owner the `store` is partitioned by — stamped onto each
  // registry entry as advisory denormalisation (the directory is authoritative).
  // Optional so scratch/test callers can ingest without a workspace context.
  wsId?: string,
  ownerId?: string,
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
    const { parts, ref, error } = await ingestOneFile(
      file,
      conversationId,
      store,
      config,
      wsId,
      ownerId,
    );
    if (error) errors.push(error);
    contentParts.push(...parts);
    if (ref) fileRefs.push(ref);
  }

  return { contentParts, fileRefs, errors };
}
