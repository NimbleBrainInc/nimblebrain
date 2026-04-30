/**
 * Normalize provider response content for the next iteration's prompt.
 *
 * The Vercel AI SDK V3 has a field-name asymmetry: provider-specific
 * metadata arrives on inbound (stream) parts as `providerMetadata`
 * (Anthropic's thinking-block signature, Google's thoughtSignature, etc.),
 * but the prompt-side converters that build the next request read from
 * `providerOptions`. Without the rename, providers drop the metadata
 * silently and the model API rejects the call:
 *
 *   - Anthropic: `messages.N.content.M: thinking blocks in the latest
 *     assistant message cannot be modified` (signature missing on
 *     reasoning blocks).
 *   - Google: `Function call is missing a thought_signature in
 *     functionCall parts` (thoughtSignature missing on tool-call blocks).
 *
 * The rename applies to **every** content type, not only reasoning.
 * Google attaches `thoughtSignature` to text, reasoning, file, AND
 * tool-call parts; Anthropic puts the signature only on reasoning today.
 * A type-discriminated rename would have shipped a hidden gap (the
 * `nb__status` Gemini failure that surfaced the issue post-PR-#142);
 * uniform application is the defensive shape.
 *
 * Tool-call blocks have a separate asymmetry that's also handled here:
 * stream output carries `input` as a JSON string, but the prompt format
 * expects a parsed object.
 *
 * Single source of truth for both renames. Both the engine (after
 * `model.doStream()`) and the conversation event reconstructor (when
 * rebuilding history from JSONL) call into it.
 *
 * Idempotent: applying twice produces the same result. The spread keeps
 * `providerMetadata` AND adds `providerOptions`; preserving the former
 * is harmless and keeps any downstream telemetry that introspects
 * inbound metadata working.
 *
 * Return type is the *prompt-side* part union (`LanguageModelV3*Part`)
 * because that's what the function actually produces — the function
 * literally translates stream-side content (`LanguageModelV3Content`,
 * which lacks `providerOptions`) into the prompt-side shape the AI SDK
 * converters consume. Typing it that way removes the need for unsafe
 * casts when adding `providerOptions` to a part.
 */

import type {
  LanguageModelV3Content,
  LanguageModelV3FilePart,
  LanguageModelV3ReasoningPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";

/** Prompt-side assistant-message content union — the shape the AI SDK
 *  converters expect on the way out. Mirror of `LanguageModelV3Message`'s
 *  assistant-role content array element type. Unexported because no
 *  caller outside this module needs the name; callers receive the same
 *  shape via `LanguageModelV3Message`'s assistant variant. */
type ReplayContent =
  | LanguageModelV3TextPart
  | LanguageModelV3ReasoningPart
  | LanguageModelV3FilePart
  | LanguageModelV3ToolCallPart
  | LanguageModelV3ToolResultPart;

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export function normalizeForReplay(content: readonly LanguageModelV3Content[]): ReplayContent[] {
  const out: ReplayContent[] = [];
  for (const part of content) {
    if (part.type === "tool-call") {
      // Spread keeps every field of the original (toolCallId, toolName,
      // providerExecuted, providerMetadata, etc.); the explicit `input`
      // overrides the stream-side string with the parsed object;
      // `providerOptions` is added when there's metadata to surface.
      // Inferred type is structurally assignable to ToolCallPart — we
      // skip the explicit annotation so TS doesn't excess-property-check
      // the carried-through `providerMetadata` (which is fine to keep
      // for telemetry but not declared on the prompt-side part type).
      const input = typeof part.input === "string" ? safeJsonParse(part.input) : part.input;
      const replay = {
        ...part,
        input,
        ...(part.providerMetadata && { providerOptions: part.providerMetadata }),
      };
      out.push(replay);
      continue;
    }

    if (part.type === "text" || part.type === "reasoning" || part.type === "file") {
      // Stream-side and prompt-side have the same field shape for these
      // three (type + payload + providerMetadata|providerOptions); spread
      // keeps the payload, the conditional add lifts metadata→options.
      const replay = part.providerMetadata
        ? { ...part, providerOptions: part.providerMetadata }
        : part;
      out.push(replay);
      continue;
    }

    // Drop the rest:
    //  - tool-result: stream-side `result` field vs prompt-side `output`
    //    field have divergent shapes. In this codebase tool-results are
    //    built by the runtime as `role: "tool"` messages, NOT pulled from
    //    `doStream()` content; this branch is defensive for provider-side
    //    tool execution (e.g. Anthropic `code_execution`, server tools).
    //    Skipping rather than mis-shaping — a wrong-shaped ToolResultPart
    //    would fail the SDK's prompt validation more confusingly.
    //  - tool-approval-request, source: stream-side only, never appear in
    //    assistant prompt content.
  }
  return out;
}
