/**
 * Rehydrate `resource_link` blocks in user messages into AI SDK V4 `file`
 * parts at the `model.doStream` boundary.
 *
 * The conversation log keeps an image or PDF attachment as a `resource_link`
 * to its `files://<id>`; the files plugin holds the body. Once per run, after
 * the history is loaded and before the engine runs, every such URI is resolved
 * in one batched `resolve` as `host`, walled to the run's workspace and owner
 * (`contracts/files/CONTRACT.md` §10.4), and each found body is streamed from
 * its download URL.
 *
 * Raster images and provider-supported PDFs become `file` parts. A PDF the
 * model cannot take gets its text from the plugin's `read` instead. Any other
 * `resource_link` becomes a short text reference the model can follow with
 * `files__read`.
 */

import type {
  LanguageModelV4FilePart,
  LanguageModelV4Message,
  LanguageModelV4TextPart,
} from "@ai-sdk/provider";
import type { StoredMessage, UserContentPart } from "../conversation/types.ts";
import type { FileInputPolicy } from "../model/file-capabilities.ts";
import {
  acceptsFileMime,
  FILE_INPUT_MIMES,
  getFileInputPolicy,
} from "../model/file-capabilities.ts";
import { log } from "../observability/log.ts";
import type { FilesHost, OwnerScope, Resolved } from "./host.ts";
import { humanSize } from "./human-size.ts";
import { TRUNCATED_NOTE } from "./intake.ts";
import { bareType, PDF_TYPE, REHYDRATABLE_IMAGE_TYPES } from "./mime.ts";
import { readAll } from "./serve.ts";
import { uriToFileId } from "./uri.ts";

// Internal runtime seam: callers must pass the resolved provider-qualified model.
export interface RehydrateOptions {
  model: string;
  maxExtractedTextSize: number;
}

/** The files the run reads bodies from: the bound plugin and the run's scope. Null when files are off. */
export type RehydrateFiles = { host: FilesHost; scope: OwnerScope } | null;

interface PdfRehydrationBudget {
  pdfRemainingBytes: number;
}

type LinkPart = Extract<UserContentPart, { type: "resource_link" }>;

/** Whether a link is one this step fetches a body or text for. */
function rehydratable(part: LinkPart): boolean {
  if (!uriToFileId(part.uri)) return false;
  const bare = bareType(part.mimeType);
  return REHYDRATABLE_IMAGE_TYPES.has(bare) || bare === PDF_TYPE;
}

export async function rehydrateUserResources(
  messages: StoredMessage[],
  files: RehydrateFiles,
  options: RehydrateOptions,
): Promise<LanguageModelV4Message[]> {
  const policy = getFileInputPolicy(options.model);
  const budget: PdfRehydrationBudget = { pdfRemainingBytes: policy.pdf?.maxTotalBytes ?? 0 };
  const resolved = await resolveAll(messages, files);
  const currentUserMessageIndex = findLastUserMessageIndex(messages);
  const out: LanguageModelV4Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as StoredMessage;
    if (msg.role !== "user") {
      // Strip the platform extras (timestamp, userId, metadata) so the
      // returned shape is exactly `LanguageModelV4Message`.
      const { role, content, providerOptions } = msg;
      out.push(
        providerOptions
          ? ({ role, content, providerOptions } as LanguageModelV4Message)
          : ({ role, content } as LanguageModelV4Message),
      );
      continue;
    }
    const newContent: Array<LanguageModelV4TextPart | LanguageModelV4FilePart> = [];
    for (const part of msg.content) {
      newContent.push(
        await rehydratePart(part, files, resolved, policy, budget, {
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

/** One `resolve` for every rehydratable URI in the user messages, by URI. */
async function resolveAll(
  messages: StoredMessage[],
  files: RehydrateFiles,
): Promise<Map<string, Resolved>> {
  const uris = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const part of msg.content) {
      if (part.type === "resource_link" && rehydratable(part)) uris.add(part.uri);
    }
  }
  const out = new Map<string, Resolved>();
  if (!files || uris.size === 0) return out;
  try {
    for (const answer of await files.host.resolve(files.scope, [...uris])) {
      out.set(answer.uri, answer);
    }
  } catch (err) {
    log.warn("[files] resolving a run's attachments failed", {
      error: err instanceof Error ? err.message : String(err),
    });
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
  files: RehydrateFiles,
  resolved: ReadonlyMap<string, Resolved>,
  policy: FileInputPolicy,
  budget: PdfRehydrationBudget,
  options: { isCurrentUserMessage: boolean; maxExtractedTextSize: number },
): Promise<LanguageModelV4TextPart | LanguageModelV4FilePart> {
  if (part.type === "text") return { type: "text", text: part.text };
  if (!rehydratable(part)) return textMarker(part.name, part.mimeType);
  const answer = resolved.get(part.uri);
  if (!files || !answer?.found) return unavailable(part.name);
  const recorded = bareType(answer.file.mimeType);
  try {
    if (REHYDRATABLE_IMAGE_TYPES.has(recorded)) return await bodyPart(part, files, answer);
    if (recorded !== PDF_TYPE) return textMarker(part.name, answer.file.mimeType);
    const pdfPolicy =
      options.isCurrentUserMessage && acceptsFileMime(policy, FILE_INPUT_MIMES.pdf)
        ? policy.pdf
        : undefined;
    const size = answer.file.size;
    if (pdfPolicy && size <= pdfPolicy.maxFileBytes && size <= budget.pdfRemainingBytes) {
      budget.pdfRemainingBytes -= size;
      return await bodyPart(part, files, answer);
    }
    return await pdfText(part, files, answer, options.maxExtractedTextSize);
  } catch (err) {
    log.warn("[files] rehydrating an attachment failed", {
      fileId: answer.file.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return unavailable(part.name);
  }
}

/** The body of a found file, as a `file` part. */
async function bodyPart(
  part: LinkPart,
  files: NonNullable<RehydrateFiles>,
  answer: Extract<Resolved, { found: true }>,
): Promise<LanguageModelV4FilePart> {
  const got = await files.host.transfer.download(answer.download.url, { size: answer.file.size });
  return {
    type: "file",
    mediaType: bareType(answer.file.mimeType),
    data: { type: "data", data: await readAll(got.body, got.length) },
    filename: part.name,
  };
}

/** A PDF's text from the plugin's `read`, for a model that does not take its bytes. */
async function pdfText(
  part: LinkPart,
  files: NonNullable<RehydrateFiles>,
  answer: Extract<Resolved, { found: true }>,
  maxBytes: number,
): Promise<LanguageModelV4TextPart> {
  const { id, size } = answer.file;
  const read = await files.host.read(files.scope, id, maxBytes);
  if (typeof read.extractedText !== "string") {
    return {
      type: "text",
      text: `[Attached PDF: ${part.name} (${answer.file.mimeType}). This model cannot receive the PDF bytes directly, and its text could not be read.]`,
    };
  }
  const hint = `To inspect specific pages, call files__read with id "${id}" and \`pages\` (1-based, at most 10).`;
  return {
    type: "text",
    text: `--- Attached PDF: ${part.name} (${id}, ${humanSize(size)}) ---\n${read.extractedText}${read.truncated ? TRUNCATED_NOTE : ""}\n${hint}`,
  };
}

function unavailable(name: string): LanguageModelV4TextPart {
  return { type: "text", text: `[Attachment unavailable: ${name}]` };
}

function textMarker(name: string, mimeType: string): LanguageModelV4TextPart {
  return {
    type: "text",
    text: `[Attached: ${name} (${mimeType}) — call files__read to access]`,
  };
}
