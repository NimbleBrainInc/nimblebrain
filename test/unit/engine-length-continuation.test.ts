import { describe, expect, it } from "bun:test";
import { AgentEngine } from "../../src/engine/engine.ts";
import { MAX_LENGTH_CONTINUATIONS } from "../../src/limits.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type {
  EngineConfig,
  EngineEvent,
  EventSink,
  ToolCall,
  ToolResult,
  ToolSchema,
} from "../../src/engine/types.ts";
import type { LanguageModelV3 } from "@ai-sdk/provider";

const config: EngineConfig = {
  model: "test-model",
  maxIterations: 10,
  maxInputTokens: 500_000,
  maxOutputTokens: 16_384,
};

function collectingSink(): { sink: EventSink; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  return { sink: { emit: (e) => events.push(e) }, events };
}

function makeEngine(
  model: LanguageModelV3,
  sink: EventSink,
  tools?: { schemas: ToolSchema[]; handler: (call: ToolCall) => ToolResult | Promise<ToolResult> },
) {
  return new AgentEngine(
    model,
    new StaticToolRouter(
      tools?.schemas ?? [],
      tools?.handler ?? (() => ({ content: textContent("ok"), isError: false })),
    ),
    sink,
  );
}

const userMsg = [{ role: "user" as const, content: [{ type: "text" as const, text: "Write." }] }];

describe("AgentEngine — output-ceiling (length) auto-resume", () => {
  it("test_length_truncation_no_toolcall_resumes_and_stitches", async () => {
    // A turn cut off at the output ceiling (finishReason "length") with no
    // tool call must resume from the partial text, not end the run.
    const { sink, events } = collectingSink();
    const model = createEchoModel({
      responses: [
        { text: "Part one", finishReason: "length" },
        { text: " and part two", finishReason: "stop" },
      ],
    });
    const result = await makeEngine(model, sink).run(config, "sys", userMsg, []);

    // Stitched with no injected blank line, run completed normally.
    expect(result.output).toBe("Part one and part two");
    expect(result.stopReason).toBe("complete");
    expect(result.iterations).toBe(2);
    expect(events.filter((e) => e.type === "context.length_continuation")).toHaveLength(1);
  });

  it("test_persistent_length_truncation_bounded_then_ends_length", async () => {
    // A response that never stops growing must not spin forever: after
    // MAX_LENGTH_CONTINUATIONS resumes the run ends with stopReason "length".
    const { sink, events } = collectingSink();
    const responses = Array.from({ length: MAX_LENGTH_CONTINUATIONS + 3 }, () => ({
      text: "x",
      finishReason: "length" as const,
    }));
    const result = await makeEngine(createEchoModel({ responses }), sink).run(
      config,
      "sys",
      userMsg,
      [],
    );

    expect(result.stopReason).toBe("length");
    expect(events.filter((e) => e.type === "context.length_continuation")).toHaveLength(
      MAX_LENGTH_CONTINUATIONS,
    );
    // Bounded well under the iteration cap — it did not run away.
    expect(result.iterations).toBeLessThan(config.maxIterations);
  });

  it("test_normal_stop_no_toolcall_ends_immediately", async () => {
    // Regression guard: a genuine stop (the common case) still ends the run
    // in one iteration — auto-resume must not trigger on non-length finishes.
    const { sink, events } = collectingSink();
    const model = createEchoModel({ responses: [{ text: "Done.", finishReason: "stop" }] });
    const result = await makeEngine(model, sink).run(config, "sys", userMsg, []);

    expect(result.output).toBe("Done.");
    expect(result.stopReason).toBe("complete");
    expect(result.iterations).toBe(1);
    expect(events.filter((e) => e.type === "context.length_continuation")).toHaveLength(0);
  });

  it("test_length_truncation_with_toolcall_takes_tool_path_not_resume", async () => {
    // A length finish that still carries a tool call is not a text
    // truncation — it must follow the normal tool path, never the resume.
    const { sink, events } = collectingSink();
    const schemas: ToolSchema[] = [
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
    const result = await makeEngine(model, sink, {
      schemas,
      handler: () => ({ content: textContent("tool ran"), isError: false }),
    }).run(config, "sys", userMsg, schemas);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.stopReason).toBe("complete");
    expect(events.filter((e) => e.type === "context.length_continuation")).toHaveLength(0);
  });

  it("test_length_truncation_mid_thinking_unsigned_reasoning_surfaces", async () => {
    // A length cut DURING extended thinking produces a reasoning block with
    // no signature. Replaying it as the trailing assistant message is what
    // Anthropic rejects, so the engine must NOT resume — it surfaces
    // stopReason "length" instead.
    const { sink, events } = collectingSink();
    const model = createEchoModel({
      responses: [{ reasoning: "thinking hard", text: "", finishReason: "length" }],
    });
    const result = await makeEngine(model, sink).run(config, "sys", userMsg, []);

    expect(result.stopReason).toBe("length");
    expect(result.iterations).toBe(1);
    expect(events.filter((e) => e.type === "context.length_continuation")).toHaveLength(0);
  });

  it("test_length_truncation_signed_reasoning_then_text_resumes", async () => {
    // Thinking COMPLETED (signature present) and only the visible text was
    // truncated — safe to resume from the signed partial.
    const { sink, events } = collectingSink();
    const model = createEchoModel({
      responses: [
        {
          reasoning: "done thinking",
          reasoningProviderMetadata: { anthropic: { signature: "sig123" } },
          text: "Begin",
          finishReason: "length",
        },
        { text: " end", finishReason: "stop" },
      ],
    });
    const result = await makeEngine(model, sink).run(config, "sys", userMsg, []);

    expect(result.output).toBe("Begin end");
    expect(result.stopReason).toBe("complete");
    expect(events.filter((e) => e.type === "context.length_continuation")).toHaveLength(1);
  });
});
