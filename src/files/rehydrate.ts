/**
 * Rehydrate `resource_link` blocks in user messages into AI SDK V3
 * `file` parts at the `model.doStream` boundary.
 *
 * The conversation log persists rehydratable attachments as MCP
 * `resource_link` blocks pointing to `files://<id>` URIs (the bytes live
 * in the workspace `FileStore`). The model expects inline `file` parts with
 * raw bytes. This module is the lazy adapter between the two — invoked once
 * per `runtime.chat` after history is loaded and before the engine is run.
 *
 * Raster images and provider-supported PDFs become `file` parts. Other
 * `resource_link` blocks become a short text reference; the model can pull
 * bytes for those via `files__read` when it needs them, and the AI SDK
 * provider would drop unknown blocks at the API boundary anyway.
 */

import type {
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3TextPart,
} from "@ai-sdk/provider";
import type { StoredMessage, UserContentPart } from "../conversation/types.ts";
import type { FileInputPolicy } from "../model/file-capabilities.ts";
import {
  acceptsFileMime,
  FILE_INPUT_MIMES,
  getFileInputPolicy,
} from "../model/file-capabilities.ts";
import { extractText, REHYDRATE_TRUNCATED_SUFFIX } from "./extract.ts";
import { IMAGE_TYPES, PDF_TYPES } from "./ingest.ts";
import type { FileStore } from "./store.ts";
import type { ExtractedTextSidecar } from "./types.ts";
import { uriToFileId } from "./uri.ts";

/**
 * MIME types we inline as vision content. Derived from the storage-side
 * `IMAGE_TYPES` minus `image/svg+xml` — Anthropic's vision input is
 * raster-only, and SVG is best read by the model as text via
 * `files__read`. Coupling to `IMAGE_TYPES` prevents the storage and
 * model-call sets from drifting; the SVG exclusion is the only delta.
 */
const REHYDRATABLE_IMAGE_MIMES = new Set([...IMAGE_TYPES].filter((m) => m !== "image/svg+xml"));

// Internal runtime seam: callers must pass the resolved provider-qualified model.
export interface RehydrateOptions {
  model: string;
  maxExtractedTextSize: number;
}

interface PdfRehydrationBudget {
  pdfRemainingBytes: number;
}

export async function rehydrateUserResources(
  messages: StoredMessage[],
  fileStore: FileStore,
  options: RehydrateOptions,
): Promise<LanguageModelV3Message[]> {
  const policy = getFileInputPolicy(options.model);
  // PDF-only guard for provider file-input limits. Existing image inlining is
  // intentionally unchanged here; full request-byte budgeting is separate.
  const budget: PdfRehydrationBudget = {
    pdfRemainingBytes: policy.pdf?.maxTotalBytes ?? 0,
  };
  const currentUserMessageIndex = findLastUserMessageIndex(messages);
  const out: LanguageModelV3Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") {
      // Strip the platform extras (timestamp, userId, metadata) so the
      // returned shape is exactly `LanguageModelV3Message` — what the
      // engine and `model.doStream` expect.
      const { role, content, providerOptions } = msg;
      out.push(
        providerOptions
          ? ({ role, content, providerOptions } as LanguageModelV3Message)
          : ({ role, content } as LanguageModelV3Message),
      );
      continue;
    }

    const newContent: Array<LanguageModelV3TextPart | LanguageModelV3FilePart> = [];
    for (const part of msg.content) {
      newContent.push(
        await rehydratePart(part, fileStore, policy, budget, {
          isCurrentUserMessage: i === currentUserMessageIndex,
          maxExtractedTextSize: options.maxExtractedTextSize,
        }),
      );
    }
    out.push(
      msg.providerOptions
        ? { role: "user", content: newContent, providerOptions: msg.providerOptions }
        : { role: "user", content: newContent },
    );
  }
  return out;
}

function findLastUserMessageIndex(messages: StoredMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

async function rehydratePart(
  part: UserContentPart,
  fileStore: FileStore,
  policy: FileInputPolicy,
  budget: PdfRehydrationBudget,
  options: { isCurrentUserMessage: boolean; maxExtractedTextSize: number },
): Promise<LanguageModelV3TextPart | LanguageModelV3FilePart> {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  // resource_link
  if (REHYDRATABLE_IMAGE_MIMES.has(part.mimeType)) {
    return rehydrateImagePart(part, fileStore);
  }
  if (PDF_TYPES.has(part.mimeType)) {
    return rehydratePdfPart(part, fileStore, policy, budget, options);
  }
  return textMarker(part.name, part.mimeType);
}

async function rehydrateImagePart(
  part: Extract<UserContentPart, { type: "resource_link" }>,
  fileStore: FileStore,
): Promise<LanguageModelV3TextPart | LanguageModelV3FilePart> {
  const id = uriToFileId(part.uri);
  if (!id) {
    return { type: "text", text: `[Attached: ${part.name}]` };
  }
  try {
    const read = await fileStore.readFile(id);
    // The persisted link's MIME got us past the early-exit check; the
    // FileStore is the source of truth for what the bytes actually are.
    // If they disagree (manual JSONL edit, mid-flight schema migration),
    // trust the store and fall back to a text marker rather than send a
    // mis-typed part to the model.
    if (!REHYDRATABLE_IMAGE_MIMES.has(read.mimeType)) {
      return textMarker(part.name, read.mimeType);
    }
    return {
      type: "file",
      mediaType: read.mimeType,
      data: new Uint8Array(read.data),
      filename: part.name,
    };
  } catch {
    // The file was deleted (tombstoned) or never existed. Surface a
    // text marker so the model sees that the attachment is gone rather
    // than silently dropping it.
    return { type: "text", text: `[Attachment unavailable: ${part.name}]` };
  }
}

async function rehydratePdfPart(
  part: Extract<UserContentPart, { type: "resource_link" }>,
  fileStore: FileStore,
  policy: FileInputPolicy,
  budget: PdfRehydrationBudget,
  options: { isCurrentUserMessage: boolean; maxExtractedTextSize: number },
): Promise<LanguageModelV3TextPart | LanguageModelV3FilePart> {
  const id = uriToFileId(part.uri);
  if (!id) {
    return { type: "text", text: `[Attached: ${part.name}]` };
  }

  try {
    const entry = await fileStore.findEntry(id);
    if (!entry) {
      return { type: "text", text: `[Attachment unavailable: ${part.name}]` };
    }
    if (!PDF_TYPES.has(entry.mimeType)) {
      return textMarker(part.name, entry.mimeType);
    }

    // Narrow the policy once. `acceptsFileMime` already gates on
    // `policy.pdf` being defined, but we need the narrowed reference
    // for the size + budget checks below.
    const pdfPolicy =
      options.isCurrentUserMessage && acceptsFileMime(policy, FILE_INPUT_MIMES.pdf)
        ? policy.pdf
        : undefined;

    const canInlineNativePdf =
      pdfPolicy !== undefined &&
      entry.size <= pdfPolicy.maxFileBytes &&
      entry.size <= budget.pdfRemainingBytes;

    if (canInlineNativePdf) {
      // Native inline path: bytes go straight to the model. We also
      // opportunistically populate the extracted-text sidecar so the
      // next turn (when this PDF is historical) hits the cache instead
      // of re-loading bytes and re-running unpdf.
      const read = await fileStore.readFile(id);
      if (!PDF_TYPES.has(read.mimeType)) {
        return textMarker(part.name, read.mimeType);
      }
      budget.pdfRemainingBytes -= read.size;
      void ensureSidecar(fileStore, id, read.data, read.mimeType, options.maxExtractedTextSize);
      return {
        type: "file",
        mediaType: read.mimeType,
        data: new Uint8Array(read.data),
        filename: part.name,
      };
    }

    // Text fallback: try the cached sidecar first. On hit, no bytes
    // are loaded off disk and unpdf is not invoked.
    const sidecar = await readUsableSidecar(fileStore, id, options.maxExtractedTextSize);
    if (sidecar) {
      return formatPdfFallback(part.name, id, entry.size, sidecar.text);
    }

    // Cache miss — fall back to live extraction and persist the result
    // so subsequent turns are cheap. This is the only path that loads
    // bytes for a non-current PDF.
    const read = await fileStore.readFile(id);
    if (!PDF_TYPES.has(read.mimeType)) {
      return textMarker(part.name, read.mimeType);
    }
    const extracted = await extractAndPersist(
      fileStore,
      id,
      read.data,
      read.mimeType,
      options.maxExtractedTextSize,
    );
    if (!extracted) {
      return {
        type: "text",
        text: `[Attached PDF: ${part.name} (${read.mimeType}). This model cannot receive the PDF bytes directly, and text extraction failed.]`,
      };
    }
    return formatPdfFallback(part.name, id, read.size, extracted.text);
  } catch {
    return { type: "text", text: `[Attachment unavailable: ${part.name}]` };
  }
}

/**
 * Return a sidecar suitable for the current `maxExtractedTextSize`. A
 * sidecar written with a smaller budget is treated as stale because the
 * caller may now want more text; a sidecar written with a larger budget
 * is still usable (its text is bounded by the larger limit and the
 * extracted-truncation suffix is stable).
 */
async function readUsableSidecar(
  fileStore: FileStore,
  id: string,
  maxExtractedTextSize: number,
): Promise<ExtractedTextSidecar | null> {
  const sidecar = await fileStore.readExtractedText(id);
  if (!sidecar) return null;
  if (sidecar.maxSize < maxExtractedTextSize) return null;
  return sidecar;
}

async function extractAndPersist(
  fileStore: FileStore,
  id: string,
  data: Buffer,
  mimeType: string,
  maxExtractedTextSize: number,
): Promise<ExtractedTextSidecar | null> {
  const result = await extractText(data, mimeType, maxExtractedTextSize, {
    truncatedSuffix: REHYDRATE_TRUNCATED_SUFFIX,
  });
  if (!result) return null;
  const sidecar: ExtractedTextSidecar = {
    text: result.text,
    maxSize: maxExtractedTextSize,
    truncated: result.truncated,
  };
  try {
    await fileStore.writeExtractedText(id, sidecar);
  } catch {
    // Sidecar persistence is an optimisation; failing to write should
    // not fail the rehydration.
  }
  return sidecar;
}

/**
 * Background sidecar population for the native-inline path. We've already
 * loaded the bytes for the file part, so extraction is cheap relative to
 * the model call. Running it without awaiting means the user-visible
 * latency on this turn is unchanged; on the next turn (this PDF now
 * historical) the cache will be warm.
 */
function ensureSidecar(
  fileStore: FileStore,
  id: string,
  data: Buffer,
  mimeType: string,
  maxExtractedTextSize: number,
): void {
  void (async () => {
    const existing = await fileStore.readExtractedText(id);
    if (existing && existing.maxSize >= maxExtractedTextSize) return;
    await extractAndPersist(fileStore, id, data, mimeType, maxExtractedTextSize);
  })().catch(() => {
    // Best effort; rehydrate's text-fallback path will retry on miss.
  });
}

function formatPdfFallback(
  name: string,
  id: string,
  size: number,
  text: string,
): LanguageModelV3TextPart {
  return {
    type: "text",
    text: `--- Attached PDF: ${name} (${id}, ${humanSize(size)}) ---\n${text}`,
  };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function textMarker(name: string, mimeType: string): LanguageModelV3TextPart {
  return {
    type: "text",
    text: `[Attached: ${name} (${mimeType}) — call files__read to access]`,
  };
}
