import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import { withSpan } from "../observability/index.ts";

export interface StreamResult {
  content: LanguageModelV3Content[];
  usage: LanguageModelV3Usage;
  finishReason: LanguageModelV3FinishReason;
}

/**
 * Trace one model call as an `llm.call` span nested under the active
 * `agent.turn`. Attributes are operational only — model id, provider, token
 * counts, finish reason. Prompt and completion content are NEVER recorded.
 */
export async function callModel(
  model: LanguageModelV3,
  options: LanguageModelV3CallOptions,
  onTextDelta: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  onToolInputStart?: (id: string, toolName: string) => void,
  onToolInputEnd?: (id: string) => void,
): Promise<StreamResult> {
  return withSpan(
    "llm.call",
    { "llm.model": model.modelId, "llm.provider": model.provider },
    async (span) => {
      const result = await callModelInner(
        model,
        options,
        onTextDelta,
        onReasoningDelta,
        onToolInputStart,
        onToolInputEnd,
      );
      span.setAttrs({
        "llm.tokens.input": result.usage.inputTokens.total ?? 0,
        "llm.tokens.output": result.usage.outputTokens.total ?? 0,
        "llm.finish_reason": result.finishReason.unified,
      });
      return result;
    },
  );
}

async function callModelInner(
  model: LanguageModelV3,
  options: LanguageModelV3CallOptions,
  onTextDelta: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
  /**
   * Called once when the model begins emitting a tool-call block, with
   * the tool name already known. Lets the engine surface "Calling X…"
   * during the dark gap where the model is streaming a large tool
   * input — `tool.start` only fires after `callModel` returns.
   *
   * Provider-agnostic: AI SDK V3 normalizes `tool-input-start` across
   * Anthropic / OpenAI / Google. Providers that never emit it simply
   * skip the callback (engine falls back to `tool.start`-only signals,
   * matching legacy behavior).
   */
  onToolInputStart?: (id: string, toolName: string) => void,
  onToolInputEnd?: (id: string) => void,
): Promise<StreamResult> {
  const { stream } = await model.doStream(options);

  const content: LanguageModelV3Content[] = [];
  let usage: LanguageModelV3Usage = {
    inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 0, text: undefined, reasoning: undefined },
  };
  // Default if the stream ends without a `finish` part. "other" is the
  // V3-defined catch-all for unclassified stops; using it directly avoids
  // the runtime-vs-type lie of `"unknown" as "other"`.
  let finishReason: LanguageModelV3FinishReason = { unified: "other", raw: undefined };

  let accumulatedText = "";
  let accumulatedReasoning = "";
  // Reasoning provider metadata accumulator. Anthropic transports the
  // thinking-block signature as a separate `signature_delta` event that
  // the AI SDK forwards as a `reasoning-delta` with empty text and
  // `providerMetadata.anthropic.signature`. Without persisting that
  // signature, the next iteration's prompt fails to round-trip the
  // reasoning block — the AI SDK provider drops it as "unsupported
  // reasoning metadata" and Anthropic 400s the request.
  let reasoningProviderMetadata: SharedV3ProviderMetadata | undefined;

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value: part } = await reader.read();
      if (done) break;

      switch (part.type) {
        case "text-start":
          accumulatedText = "";
          break;

        case "text-delta":
          onTextDelta(part.delta);
          accumulatedText += part.delta;
          break;

        case "text-end":
          if (accumulatedText) {
            content.push({ type: "text", text: accumulatedText });
          }
          accumulatedText = "";
          break;

        // Reasoning (extended thinking) parts. Treated symmetrically with
        // text: deltas accumulate into a single content block on -end.
        // Without this case, reasoning tokens are billed but never appear
        // in `content[]` — turns that produce only reasoning render as
        // empty (the failure mode that started this whole thread).
        // Provider metadata (e.g. Anthropic's thinking signature) is
        // merged across all reasoning-* parts of a block so the block
        // can round-trip on the next iteration's prompt.
        case "reasoning-start":
          accumulatedReasoning = "";
          reasoningProviderMetadata = part.providerMetadata
            ? { ...part.providerMetadata }
            : undefined;
          break;

        case "reasoning-delta":
          onReasoningDelta?.(part.delta);
          accumulatedReasoning += part.delta;
          if (part.providerMetadata) {
            reasoningProviderMetadata = mergeProviderMetadata(
              reasoningProviderMetadata,
              part.providerMetadata,
            );
          }
          break;

        case "reasoning-end":
          if (accumulatedReasoning || reasoningProviderMetadata) {
            content.push({
              type: "reasoning",
              text: accumulatedReasoning,
              ...(reasoningProviderMetadata ? { providerMetadata: reasoningProviderMetadata } : {}),
            });
          }
          accumulatedReasoning = "";
          reasoningProviderMetadata = undefined;
          break;

        // Tool-input parts: surface model-side tool intent before the
        // engine actually dispatches the tool. `-delta` is intentionally
        // not forwarded — per-char SSE traffic for no UI gain (the chat
        // shows tool *intent*, not the JSON forming).
        case "tool-input-start":
          onToolInputStart?.(part.id, part.toolName);
          break;

        case "tool-input-delta":
          break;

        case "tool-input-end":
          onToolInputEnd?.(part.id);
          break;

        case "tool-call":
          content.push(part);
          break;

        case "finish":
          usage = part.usage;
          finishReason = part.finishReason;
          break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Drain any in-flight accumulators that didn't see their -end part.
  if (accumulatedText) {
    content.push({ type: "text", text: accumulatedText });
  }
  if (accumulatedReasoning || reasoningProviderMetadata) {
    content.push({
      type: "reasoning",
      text: accumulatedReasoning,
      ...(reasoningProviderMetadata ? { providerMetadata: reasoningProviderMetadata } : {}),
    });
  }

  return { content, usage, finishReason };
}

/**
 * Shallow-merge two provider-metadata bags by provider key. Each provider
 * gets its own object spread together; later keys win. The AI SDK only
 * cares about the per-provider sub-object (e.g. `anthropic.signature`),
 * so a deeper merge isn't needed.
 */
function mergeProviderMetadata(
  a: SharedV3ProviderMetadata | undefined,
  b: SharedV3ProviderMetadata,
): SharedV3ProviderMetadata {
  if (!a) return { ...b };
  const out: SharedV3ProviderMetadata = { ...a };
  for (const [provider, meta] of Object.entries(b)) {
    out[provider] = { ...(out[provider] ?? {}), ...(meta ?? {}) };
  }
  return out;
}
