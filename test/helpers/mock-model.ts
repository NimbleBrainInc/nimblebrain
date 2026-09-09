import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4Message,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolCall,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";

/**
 * A mock response in the old ModelPort style, automatically converted to V3.
 *
 * content uses V3 types directly:
 *   - { type: "text", text: "..." }
 *   - { type: "tool-call", toolCallId: "...", toolName: "...", input: "..." }
 */
export interface MockModelResponse {
  content: LanguageModelV4Content[];
  inputTokens?: number;
  outputTokens?: number;
  /** "stop" (default for no tool calls) or "tool-calls" */
  finishReason?: "stop" | "tool-calls";
}

export type MockCallFn = (options: LanguageModelV4CallOptions) => MockModelResponse | Promise<MockModelResponse>;

/**
 * Extract the `<runtime-context>` head the runtime prepends to the latest user
 * message. PR-1 (volatility-tiered composition) moves per-turn-volatile content
 * — current date, app/focused-app state, matched skill — out of the cached
 * system block onto this head. Tests that assert on "what the model sees" append
 * it to the captured system message. Returns "" when no head is present.
 */
export function runtimeContextHead(prompt: LanguageModelV4CallOptions["prompt"]): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role !== "user") continue;
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text" && part.text.startsWith("<runtime-context>")) {
          return `\n\n${part.text}`;
        }
      }
    }
    return "";
  }
  return "";
}

/**
 * Creates a LanguageModelV4 from a function that returns MockModelResponse.
 * This makes it easy to port old ModelPort-style mocks.
 *
 * The onTextDelta callback is NOT wired (since the engine uses the stream,
 * not the mock's internal signaling). Text deltas are emitted as stream parts.
 */
export function createMockModel(callFn: MockCallFn): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "mock",
    modelId: "mock-model",
    supportedUrls: {},

    async doGenerate(options) {
      const resp = await callFn(options);
      return {
        content: resp.content,
        finishReason: buildFinishReason(resp),
        usage: buildUsage(resp),
        warnings: [],
      };
    },

    async doStream(options) {
      const resp = await callFn(options);
      const parts: LanguageModelV4StreamPart[] = [];

      parts.push({ type: "stream-start", warnings: [] });

      for (const item of resp.content) {
        if (item.type === "text") {
          parts.push({ type: "text-start", id: "text-0" });
          parts.push({ type: "text-delta", id: "text-0", delta: item.text });
          parts.push({ type: "text-end", id: "text-0" });
        } else if (item.type === "tool-call") {
          const tc = item as LanguageModelV4ToolCall;
          parts.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          });
        }
      }

      parts.push({
        type: "finish",
        usage: buildUsage(resp),
        finishReason: buildFinishReason(resp),
      });

      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      });

      return { stream };
    },
  };
}

function buildFinishReason(resp: MockModelResponse): LanguageModelV4FinishReason {
  if (resp.finishReason) {
    return { unified: resp.finishReason, raw: undefined };
  }
  const hasToolCalls = resp.content.some((c) => c.type === "tool-call");
  return {
    unified: hasToolCalls ? "tool-calls" : "stop",
    raw: undefined,
  };
}

function buildUsage(resp: MockModelResponse): LanguageModelV4Usage {
  return {
    inputTokens: {
      total: resp.inputTokens ?? 10,
      noCache: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: resp.outputTokens ?? 5,
      text: undefined,
      reasoning: undefined,
    },
  };
}
