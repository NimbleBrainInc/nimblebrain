import { describe, expect, it } from "bun:test";
import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { AgentEngine } from "../../src/engine/engine.ts";
import type { EngineConfig } from "../../src/engine/types.ts";
import { createEchoModel } from "../helpers/echo-model.ts";

const config: EngineConfig = {
  model: "test-model",
  maxIterations: 10,
  maxInputTokens: 500_000,
  maxOutputTokens: 16_384,
};

describe("AgentEngine — output-ceiling (length) truncation", () => {
  it("ends the run with stopReason 'length' after one call, never sending an assistant-final history", async () => {
    // A no-tool-call turn cut off at the output ceiling ends the run. Calling
    // the model again would send a history ending on the partial assistant
    // message (an assistant prefill), which Anthropic models reject.
    const prompts: LanguageModelV4CallOptions["prompt"][] = [];
    const model: LanguageModelV4 = {
      ...createEchoModel({
        responses: [
          { text: "Part one", finishReason: "length" },
          { text: " and part two", finishReason: "stop" },
        ],
      }),
    };
    const orig = model.doStream.bind(model);
    model.doStream = async (callOptions) => {
      prompts.push(callOptions.prompt);
      return orig(callOptions);
    };

    const result = await new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      new NoopEventSink(),
    ).run(config, "sys", [{ role: "user", content: [{ type: "text", text: "Write." }] }], []);

    expect(result.stopReason).toBe("length");
    expect(result.finishReason).toBe("length");
    expect(result.output).toBe("Part one");
    expect(result.iterations).toBe(1);
    expect(prompts).toHaveLength(1);
  });

  it("runs the tool path when a length-truncated turn carries a tool call", async () => {
    // Only a no-tool-call length turn ends the run; a turn with a tool call
    // executes it and calls the model again with the tool result.
    const schemas = [
      { name: "noop", description: "noop", inputSchema: { type: "object", properties: {} } },
    ];
    const model = createEchoModel({
      responses: [
        {
          text: "calling",
          finishReason: "length",
          toolCalls: [{ toolCallId: "c1", toolName: "noop", input: "{}" }],
        },
        { text: "after tool", finishReason: "stop" },
      ],
    });

    const result = await new AgentEngine(
      model,
      new StaticToolRouter(schemas, () => ({ content: textContent("tool ran"), isError: false })),
      new NoopEventSink(),
    ).run(config, "sys", [{ role: "user", content: [{ type: "text", text: "Go." }] }], schemas);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.stopReason).toBe("complete");
    expect(result.iterations).toBe(2);
  });
});
