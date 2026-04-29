/**
 * Normalize provider response content for the next iteration's prompt.
 *
 * The Vercel AI SDK V3 has an asymmetric reasoning shape: provider metadata
 * (e.g. Anthropic's thinking-block signature) arrives in `providerMetadata`
 * on the way IN from `model.doStream()`, but the prompt-side converter that
 * builds the next request reads `providerOptions`. Without the rename, the
 * Anthropic provider drops the block as "unsupported reasoning metadata"
 * and the API rejects the call — `messages.N.content.M: thinking blocks in
 * the latest assistant message cannot be modified`.
 *
 * Tool-call blocks have a similar asymmetry: stream output carries `input`
 * as a JSON string; the prompt format expects a parsed object.
 *
 * This module is the single source of truth for both renames. Both the
 * engine (after `model.doStream()`) and the conversation event reconstructor
 * (when rebuilding history from JSONL) call into it.
 *
 * Idempotent: applying twice produces the same result.
 */

import type { LanguageModelV3Content } from "@ai-sdk/provider";

export function normalizeForReplay(
  content: readonly LanguageModelV3Content[],
): LanguageModelV3Content[] {
  return content.map((part) => {
    if (part.type === "tool-call" && typeof part.input === "string") {
      try {
        return { ...part, input: JSON.parse(part.input) };
      } catch {
        return { ...part, input: {} };
      }
    }
    if (part.type === "reasoning" && part.providerMetadata) {
      // Spread keeps `providerMetadata` AND adds `providerOptions`. The
      // AI SDK reads the latter; preserving the former is harmless and
      // keeps any downstream telemetry that introspects metadata working.
      return { ...part, providerOptions: part.providerMetadata };
    }
    return part;
  });
}
