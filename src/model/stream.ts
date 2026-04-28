import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

export interface StreamResult {
  content: LanguageModelV3Content[];
  usage: LanguageModelV3Usage;
  finishReason: LanguageModelV3FinishReason;
}

export async function callModel(
  model: LanguageModelV3,
  options: LanguageModelV3CallOptions,
  onTextDelta: (text: string) => void,
  onReasoningDelta?: (text: string) => void,
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
        case "reasoning-start":
          accumulatedReasoning = "";
          break;

        case "reasoning-delta":
          onReasoningDelta?.(part.delta);
          accumulatedReasoning += part.delta;
          break;

        case "reasoning-end":
          if (accumulatedReasoning) {
            content.push({ type: "reasoning", text: accumulatedReasoning });
          }
          accumulatedReasoning = "";
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
  if (accumulatedReasoning) {
    content.push({ type: "reasoning", text: accumulatedReasoning });
  }

  return { content, usage, finishReason };
}
