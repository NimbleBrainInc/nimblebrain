import { describe, expect, it } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { AgentEngine } from "../../src/engine/engine.ts";
import type {
  EngineConfig,
  EngineEvent,
  EventSink,
  ToolCall,
  ToolResult,
  ToolSchema,
} from "../../src/engine/types.ts";
import { createMockModel } from "../helpers/mock-model.ts";

const config: EngineConfig = {
  model: "test-model",
  maxIterations: 10,
  maxInputTokens: 500_000,
  maxOutputTokens: 16_384,
};

const stuckToolSchema: ToolSchema = {
  name: "stuck",
  description: "Always returns the same error.",
  inputSchema: { type: "object", properties: {} },
};

function collect(events: EngineEvent[]): EventSink {
  return { emit: (e) => events.push(e) };
}

describe("engine ↔ supervisor wiring", () => {
  it("emits supervisorTripped on the 3rd identical failure and stops the loop", async () => {
    // Model behaviour: emit a `stuck` tool call every iteration UNLESS the
    // supervisor's prompt nudge appears in the system prompt — then produce
    // a final text response. This mirrors how a well-behaved real model
    // responds to the synth-stop + nudge pair.
    let prepostNudge: { before: number; after: number } = { before: 0, after: 0 };
    const model = createMockModel((opts) => {
      const systemMsg = opts.prompt.find((m) => m.role === "system");
      const systemText =
        systemMsg && typeof systemMsg.content === "string" ? systemMsg.content : "";
      const sawNudge = systemText.includes(
        "A tool was detected to be in a loop",
      );
      if (sawNudge) {
        prepostNudge.after += 1;
        return {
          content: [{ type: "text", text: "Stopping per the supervisor directive." }],
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      prepostNudge.before += 1;
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `call-${prepostNudge.before}`,
            toolName: "stuck",
            input: JSON.stringify({}),
          },
        ],
        inputTokens: 1,
        outputTokens: 1,
      };
    });

    let toolCallCount = 0;
    const handler = (_call: ToolCall): ToolResult => {
      toolCallCount += 1;
      return {
        content: textContent("Request failed with status code 400"),
        isError: true,
      };
    };

    const events: EngineEvent[] = [];
    const engine = new AgentEngine(
      model,
      new StaticToolRouter([stuckToolSchema], handler),
      collect(events),
    );

    const messages: LanguageModelV3Message[] = [
      { role: "user", content: [{ type: "text", text: "do the thing" }] },
    ];

    const result = await engine.run(config, "system base", messages, [stuckToolSchema]);

    // The tool was actually invoked exactly 3 times (the supervisor caught
    // the loop on the 3rd call). Subsequent iterations don't invoke the
    // tool because the nudge stops the model from calling it again.
    expect(toolCallCount).toBe(3);

    // Loop terminated cleanly, not via max_iterations.
    expect(result.stopReason).toBe("complete");
    expect(result.iterations).toBeLessThan(config.maxIterations);

    // Final user-visible text came from the post-nudge model response.
    expect(result.output).toContain("Stopping per the supervisor directive");

    // Exactly one tool.done event carries supervisorTripped.
    const tripped = events.filter(
      (e) =>
        e.type === "tool.done" &&
        (e.data as Record<string, unknown>).supervisorTripped === true,
    );
    expect(tripped.length).toBe(1);
    const trippedData = tripped[0]!.data as Record<string, unknown>;
    expect(trippedData.trippedTool).toBe("stuck");
    expect(trippedData.consecutiveRepeats).toBe(3);
    expect(trippedData.ok).toBe(false);

    // The model saw the nudge exactly once (one post-trip iteration).
    expect(prepostNudge.before).toBe(3);
    expect(prepostNudge.after).toBe(1);
  });

  it("does not trip when tool results vary across calls", async () => {
    let callIdx = 0;
    const model = createMockModel(() => {
      callIdx += 1;
      if (callIdx > 4) {
        return {
          content: [{ type: "text", text: "Done after exploration." }],
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `call-${callIdx}`,
            toolName: "stuck",
            input: JSON.stringify({}),
          },
        ],
        inputTokens: 1,
        outputTokens: 1,
      };
    });

    let toolIdx = 0;
    const handler = (_call: ToolCall): ToolResult => {
      toolIdx += 1;
      // Different error each time — supervisor should never trip.
      return {
        content: textContent(`Request failed with status code ${400 + toolIdx}`),
        isError: true,
      };
    };

    const events: EngineEvent[] = [];
    const engine = new AgentEngine(
      model,
      new StaticToolRouter([stuckToolSchema], handler),
      collect(events),
    );

    const result = await engine.run(
      config,
      "system",
      [{ role: "user", content: [{ type: "text", text: "go" }] }],
      [stuckToolSchema],
    );

    expect(result.stopReason).toBe("complete");
    expect(toolIdx).toBe(4);
    const tripped = events.filter(
      (e) =>
        e.type === "tool.done" &&
        (e.data as Record<string, unknown>).supervisorTripped === true,
    );
    expect(tripped.length).toBe(0);
  });
});
