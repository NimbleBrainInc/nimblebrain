/**
 * Rehydrate `resource_link` blocks in user messages into AI SDK V3
 * `file` parts at the `model.doStream` boundary.
 *
 * The conversation log persists images as MCP `resource_link` blocks
 * pointing to `files://<id>` URIs (the bytes live in the workspace
 * `FileStore`). The model expects inline `file` parts with raw bytes.
 * This module is the lazy adapter between the two — invoked once per
 * `runtime.chat` after history is loaded and before the engine is run.
 *
 * Non-image `resource_link` blocks become a short text reference; the
 * model can pull bytes for those via `files__read` when it needs them,
 * and the AI SDK provider would drop unknown blocks at the API
 * boundary anyway.
 */

import type {
  LanguageModelV3FilePart,
  LanguageModelV3Message,
  LanguageModelV3TextPart,
} from "@ai-sdk/provider";
import type { StoredMessage, UserContentPart } from "../conversation/types.ts";
import type { FileStore } from "./store.ts";
import { uriToFileId } from "./uri.ts";

/**
 * Image MIME types we inline as vision content. `image/svg+xml` is
 * intentionally excluded — Anthropic's vision input is raster-only,
 * and SVG is best read by the model as text via `files__read`.
 */
const REHYDRATABLE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export async function rehydrateUserResources(
  messages: StoredMessage[],
  fileStore: FileStore,
): Promise<LanguageModelV3Message[]> {
  return Promise.all(
    messages.map(async (msg): Promise<LanguageModelV3Message> => {
      if (msg.role !== "user") {
        // Strip the platform extras (timestamp, userId, metadata) so the
        // returned shape is exactly `LanguageModelV3Message` — what the
        // engine and `model.doStream` expect.
        const { role, content, providerOptions } = msg;
        return providerOptions
          ? ({ role, content, providerOptions } as LanguageModelV3Message)
          : ({ role, content } as LanguageModelV3Message);
      }

      const newContent = await Promise.all(
        msg.content.map(async (part) => rehydratePart(part, fileStore)),
      );
      return msg.providerOptions
        ? { role: "user", content: newContent, providerOptions: msg.providerOptions }
        : { role: "user", content: newContent };
    }),
  );
}

async function rehydratePart(
  part: UserContentPart,
  fileStore: FileStore,
): Promise<LanguageModelV3TextPart | LanguageModelV3FilePart> {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  // resource_link
  if (!REHYDRATABLE_IMAGE_MIMES.has(part.mimeType)) {
    return {
      type: "text",
      text: `[Attached: ${part.name} (${part.mimeType}) — call files__read to access]`,
    };
  }
  const id = uriToFileId(part.uri);
  if (!id) {
    return { type: "text", text: `[Attached: ${part.name}]` };
  }
  try {
    const read = await fileStore.readFile(id);
    return {
      type: "file",
      mediaType: part.mimeType,
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
