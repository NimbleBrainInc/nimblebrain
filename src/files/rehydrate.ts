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
import { IMAGE_TYPES, PDF_TYPES } from "./ingest.ts";
import type { FileStore } from "./store.ts";
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
  const out: LanguageModelV3Message[] = [];
  for (const msg of messages) {
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
      newContent.push(await rehydratePart(part, fileStore, policy, budget));
    }
    out.push(
      msg.providerOptions
        ? { role: "user", content: newContent, providerOptions: msg.providerOptions }
        : { role: "user", content: newContent },
    );
  }
  return out;
}

async function rehydratePart(
  part: UserContentPart,
  fileStore: FileStore,
  policy: FileInputPolicy,
  budget: PdfRehydrationBudget,
): Promise<LanguageModelV3TextPart | LanguageModelV3FilePart> {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  // resource_link
  if (REHYDRATABLE_IMAGE_MIMES.has(part.mimeType)) {
    return rehydrateImagePart(part, fileStore);
  }
  if (PDF_TYPES.has(part.mimeType)) {
    return rehydratePdfPart(part, fileStore, policy, budget);
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
): Promise<LanguageModelV3TextPart | LanguageModelV3FilePart> {
  if (!acceptsFileMime(policy, FILE_INPUT_MIMES.pdf) || !policy.pdf) {
    return textMarker(part.name, part.mimeType);
  }

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
    if (entry.size > policy.pdf.maxFileBytes || entry.size > budget.pdfRemainingBytes) {
      return textMarker(part.name, entry.mimeType);
    }

    const read = await fileStore.readFile(id);
    if (!PDF_TYPES.has(read.mimeType)) {
      return textMarker(part.name, read.mimeType);
    }
    if (read.size > policy.pdf.maxFileBytes || read.size > budget.pdfRemainingBytes) {
      return textMarker(part.name, read.mimeType);
    }

    budget.pdfRemainingBytes -= read.size;
    return {
      type: "file",
      mediaType: read.mimeType,
      data: new Uint8Array(read.data),
      filename: part.name,
    };
  } catch {
    return { type: "text", text: `[Attachment unavailable: ${part.name}]` };
  }
}

function textMarker(name: string, mimeType: string): LanguageModelV3TextPart {
  return {
    type: "text",
    text: `[Attached: ${name} (${mimeType}) — call files__read to access]`,
  };
}
