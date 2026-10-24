/**
 * NimbleBrain's own ACP extension: the `_meta` keys our client sends and our
 * agent (`src/execution/acp-agent/`) reads, beyond what ACP v1 carries.
 *
 * ACP v1 has no slot for a client's system prompt or for history the agent did
 * not produce itself. NimbleBrain owns both (the door composes the prompt and
 * reads the history back from the conversation log), so an agent that honours
 * this extension is handed them whole at `session/new`. An agent that does not
 * gets them by its driver's other means (`AcpDriver`).
 *
 * Keys are reverse-DNS under `ai.nimblebrain/`, as ACP reserves `_meta` for.
 */

import type { ContentBlock } from "@agentclientprotocol/sdk/unstable";
import type { LanguageModelV4Message } from "@ai-sdk/provider";
import type { ResolvedThinking, StopReason } from "../../engine/types.ts";

/** On `session/new`: everything the agent needs to run the door's run. */
export const RUN_META_KEY = "ai.nimblebrain/run";

/** On a `session/prompt` response: the engine's own stop reason, finer than ACP's. */
export const STOP_REASON_META_KEY = "ai.nimblebrain/stopReason";

export interface RunMeta {
  system: string;
  /** Prior history, oldest first, encoded with {@link encodeMessages}. */
  history: string;
  model: string;
  maxIterations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  thinking?: ResolvedThinking;
}

const BYTES_TAG = "__nb_bytes";

/**
 * History as JSON. File parts carry their bytes as a `Uint8Array`, which JSON
 * would turn into an index-keyed object; they travel as base64 and come back
 * as bytes.
 */
export function encodeMessages(messages: LanguageModelV4Message[]): string {
  return JSON.stringify(messages, (_key, value) =>
    value instanceof Uint8Array ? { [BYTES_TAG]: Buffer.from(value).toString("base64") } : value,
  );
}

export function decodeMessages(encoded: string): LanguageModelV4Message[] {
  return JSON.parse(encoded, (_key, value) =>
    value && typeof value === "object" && typeof value[BYTES_TAG] === "string"
      ? new Uint8Array(Buffer.from(value[BYTES_TAG], "base64"))
      : value,
  ) as LanguageModelV4Message[];
}

type UserMessage = Extract<LanguageModelV4Message, { role: "user" }>;
type UserPart = UserMessage["content"][number];

/**
 * A user message as ACP prompt content. Text is text; inline image bytes are an
 * image; other inline bytes are an embedded resource. A part ACP cannot carry
 * becomes a text note naming it, so the agent knows something was attached.
 */
export function userMessageToPrompt(message: UserMessage): ContentBlock[] {
  return message.content.map((part): ContentBlock => {
    if (part.type === "text") return { type: "text", text: part.text };
    const data = part.data;
    if (data.type === "data") {
      const base64 =
        typeof data.data === "string" ? data.data : Buffer.from(data.data).toString("base64");
      if (part.mediaType.startsWith("image/")) {
        return { type: "image", data: base64, mimeType: part.mediaType };
      }
      return {
        type: "resource",
        resource: {
          uri: `attachment:${part.filename ?? "file"}`,
          blob: base64,
          mimeType: part.mediaType,
        },
      };
    }
    if (data.type === "text") return { type: "text", text: data.text };
    return { type: "text", text: `[attachment not carried over ACP: ${part.mediaType}]` };
  });
}

/** ACP prompt content as a user message: the inverse of {@link userMessageToPrompt}. */
export function promptToUserMessage(prompt: ContentBlock[]): UserMessage {
  const content = prompt.flatMap((block): UserPart[] => {
    switch (block.type) {
      case "text":
        return [{ type: "text", text: block.text }];
      case "image":
        return [
          {
            type: "file",
            mediaType: block.mimeType,
            data: { type: "data", data: new Uint8Array(Buffer.from(block.data, "base64")) },
          },
        ];
      case "resource": {
        const res = block.resource;
        if ("text" in res) return [{ type: "text", text: res.text }];
        return [
          {
            type: "file",
            mediaType: res.mimeType ?? "application/octet-stream",
            data: { type: "data", data: new Uint8Array(Buffer.from(res.blob, "base64")) },
          },
        ];
      }
      case "resource_link":
        return [{ type: "text", text: `[resource: ${block.uri}]` }];
      default:
        return [];
    }
  });
  return { role: "user", content };
}

/** The engine's stop reason, as ACP's coarser vocabulary names it. */
export function toAcpStopReason(
  stop: StopReason,
): "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" {
  switch (stop) {
    case "length":
      return "max_tokens";
    case "max_iterations":
      return "max_turn_requests";
    case "content_filter":
      return "refusal";
    case "cancelled":
      return "cancelled";
    default:
      return "end_turn";
  }
}
