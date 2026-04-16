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
): Promise<StreamResult> {
  const { stream } = await model.doStream(options);

  const content: LanguageModelV3Content[] = [];
  let usage: LanguageModelV3Usage = {
    inputTokens: { total: 0, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 0, text: undefined, reasoning: undefined },
  };
  let finishReason: LanguageModelV3FinishReason = { unified: "unknown" as "other", raw: undefined };

  let accumulatedText = "";

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

  // If text was accumulated without text-start/text-end framing, emit as single block
  if (accumulatedText) {
    content.push({ type: "text", text: accumulatedText });
  }

  return { content, usage, finishReason };
}
