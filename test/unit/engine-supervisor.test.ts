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
    // Model behaviour: emit a `stuck` tool call every iteration as long as
    // it's in the toolset. Once the supervisor filters it out, the model has
    // no tools to call and produces a final text response. This mirrors how
    // a real model behaves under the affordance-level recovery: the tool
    // literally isn't on the menu so it can't be picked.
    const trace: { toolsOffered: number; sawStuck: boolean }[] = [];
    const model = createMockModel((opts) => {
      const tools = opts.tools ?? [];
      const sawStuck = tools.some(
        (t) => (t as { name?: string }).name === "stuck",
      );
      trace.push({ toolsOffered: tools.length, sawStuck });
      if (!sawStuck) {
        return {
          content: [
            { type: "text", text: "Stopping — stuck tool is no longer available." },
          ],
          inputTokens: 1,
          outputTokens: 1,
        };
      }
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `call-${trace.length}`,
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
    // tool because it's filtered out of modelTools.
    expect(toolCallCount).toBe(3);

    // Loop terminated cleanly, not via max_iterations.
    expect(result.stopReason).toBe("complete");
    expect(result.iterations).toBeLessThan(config.maxIterations);

    // Final user-visible text came from the model's no-tools response.
    expect(result.output).toContain("stuck tool is no longer available");

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

    // Model saw `stuck` on the first 3 iterations, then no `stuck` after
    // the supervisor tripped.
    const withStuck = trace.filter((t) => t.sawStuck).length;
    const withoutStuck = trace.filter((t) => !t.sawStuck).length;
    expect(withStuck).toBe(3);
    expect(withoutStuck).toBe(1);
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
