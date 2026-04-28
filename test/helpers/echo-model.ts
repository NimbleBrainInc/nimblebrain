import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolCall,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

/**
 * A queued response entry. Can be plain text or include tool calls.
 */
export interface EchoModelResponse {
  text?: string;
  /**
   * Reasoning (extended-thinking) content emitted before any text/tool_use.
   * When set, the stream produces reasoning-start/delta/end parts that
   * src/model/stream.ts must capture and push as a `reasoning` content block.
   */
  reasoning?: string;
  /**
   * Optional reasoning-token subtotal reported in usage.outputTokens.reasoning.
   * Tests use this to verify the engine forwards the breakdown on llm.done.
   */
  reasoningTokens?: number;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    input: string; // stringified JSON
  }>;
  /**
   * Override the unified finish reason for this response. Defaults to
   * `tool-calls` when toolCalls are present, otherwise `stop`. Tests use
   * this to simulate length truncation, content filtering, etc.
   */
  finishReason?: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
}

export interface EchoModelOptions {
  /** Pre-programmed response queue. Consumed FIFO; when empty, falls back to echo. */
  responses?: EchoModelResponse[];
  provider?: string;
  modelId?: string;
}

/**
 * Test LanguageModelV3 that echoes the last user message or returns
 * pre-programmed responses (including tool calls) from a queue.
 */
export function createEchoModel(options?: EchoModelOptions): LanguageModelV3 {
  const queue = [...(options?.responses ?? [])];

  function extractLastUserText(
    callOptions: LanguageModelV3CallOptions,
  ): string {
    const messages = callOptions.prompt;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        for (const part of msg.content) {
          if (part.type === "text") {
            return part.text;
          }
        }
      }
    }
    return "[echo]";
  }

  function buildUsage(textLen: number, reasoningTokens?: number): LanguageModelV3Usage {
    const total = textLen + (reasoningTokens ?? 0);
    return {
      inputTokens: { total: textLen, noCache: textLen, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: {
        total,
        text: textLen,
        reasoning: reasoningTokens,
      },
    };
  }

  function buildFinishReason(hasToolCalls: boolean): LanguageModelV3FinishReason {
    return {
      unified: hasToolCalls ? "tool-calls" : "stop",
      raw: undefined,
    };
  }

  function buildResult(callOptions: LanguageModelV3CallOptions): {
    content: LanguageModelV3Content[];
    finishReason: LanguageModelV3FinishReason;
    usage: LanguageModelV3Usage;
  } {
    const queued = queue.shift();

    if (queued) {
      const content: LanguageModelV3Content[] = [];

      if (queued.reasoning !== undefined) {
        content.push({ type: "reasoning", text: queued.reasoning });
      }

      if (queued.text !== undefined) {
        content.push({ type: "text", text: queued.text });
      }

      if (queued.toolCalls) {
        for (const tc of queued.toolCalls) {
          content.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          } satisfies LanguageModelV3ToolCall);
        }
      }

      const hasToolCalls = queued.toolCalls && queued.toolCalls.length > 0;
      const textLen = queued.text?.length ?? 0;

      const finishReason: LanguageModelV3FinishReason = queued.finishReason
        ? { unified: queued.finishReason, raw: undefined }
        : buildFinishReason(!!hasToolCalls);

      return {
        content,
        finishReason,
        usage: buildUsage(textLen, queued.reasoningTokens),
      };
    }

    // Default echo behavior
    const text = extractLastUserText(callOptions);
    return {
      content: [{ type: "text", text }],
      finishReason: buildFinishReason(false),
      usage: buildUsage(text.length),
    };
  }

  return {
    specificationVersion: "v3",
    provider: options?.provider ?? "echo",
    modelId: options?.modelId ?? "echo-1",
    supportedUrls: {},

    async doGenerate(callOptions) {
      const result = buildResult(callOptions);
      return {
        ...result,
        warnings: [],
      };
    },

    async doStream(callOptions) {
      const result = buildResult(callOptions);
      const parts: LanguageModelV3StreamPart[] = [];

      // stream-start
      parts.push({ type: "stream-start", warnings: [] });

      // Emit content parts
      for (const item of result.content) {
        if (item.type === "reasoning") {
          parts.push({ type: "reasoning-start", id: "reasoning-0" });
          parts.push({ type: "reasoning-delta", id: "reasoning-0", delta: item.text });
          parts.push({ type: "reasoning-end", id: "reasoning-0" });
        } else if (item.type === "text") {
          parts.push({ type: "text-start", id: "text-0" });
          parts.push({ type: "text-delta", id: "text-0", delta: item.text });
          parts.push({ type: "text-end", id: "text-0" });
        } else if (item.type === "tool-call") {
          const tc = item as LanguageModelV3ToolCall;
          parts.push({
            type: "tool-call",
            toolCallId: tc.toolCallId,
            toolName: tc.toolName,
            input: tc.input,
          });
        }
      }

      // finish
      parts.push({
        type: "finish",
        usage: result.usage,
        finishReason: result.finishReason,
      });

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
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
