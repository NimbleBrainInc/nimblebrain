import { describe, expect, it } from "bun:test";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { AgentEngine } from "../../src/engine/engine.ts";
import type { EngineConfig, EngineEvent, ToolResult, ToolSchema } from "../../src/engine/types.ts";
import { createMockModel } from "../helpers/mock-model.ts";

const baseConfig: EngineConfig = {
  model: "test-model",
  maxIterations: 25,
  maxInputTokens: 500_000,
  maxOutputTokens: 16_384,
};

const tools: ToolSchema[] = [
  { name: "test__score", description: "Score one item", inputSchema: {} },
];

/**
 * A run shaped like a long task: each model call's input grows by
 * 1,000 tokens (call k reports k × 1,000), and the model asks for a tool on
 * every call until the fifth, which answers. Uncapped, the run spends
 * 1k + 2k + 3k + 4k + 5k = 15,000 input tokens over 5 calls.
 *
 * `reminded` records, per call, whether its last message carried the
 * final-step reminder. With `answerOnReminder` the model answers on the first
 * call that carries it, as a model that heeds the reminder does.
 */
function growingRun(
  maxRunInputTokens?: number,
  opts: { answerOnReminder?: boolean; maxIterations?: number } = {},
) {
  let calls = 0;
  const reminded: boolean[] = [];
  const model = createMockModel((callOpts) => {
    calls++;
    const prompt = callOpts.prompt;
    const sawReminder = JSON.stringify(prompt[prompt.length - 1]).includes("final step");
    reminded.push(sawReminder);
    if (opts.answerOnReminder && sawReminder) {
      return {
        content: [{ type: "text", text: "partial: some items scored" }],
        inputTokens: calls * 1_000,
        outputTokens: 10,
      };
    }
    if (calls === 5) {
      return {
        content: [{ type: "text", text: "all items scored" }],
        inputTokens: 5_000,
        outputTokens: 10,
      };
    }
    return {
      content: [
        { type: "tool-call", toolCallId: `call_${calls}`, toolName: "test__score", input: "{}" },
      ],
      inputTokens: calls * 1_000,
      outputTokens: 10,
    };
  });
  const toolRuns: string[] = [];
  const events: EngineEvent[] = [];
  const engine = new AgentEngine(
    model,
    new StaticToolRouter(tools, (call): ToolResult => {
      toolRuns.push(call.id);
      return { content: textContent("scored"), isError: false };
    }),
    { emit: (e) => events.push(e) },
  );
  const config: EngineConfig = {
    ...baseConfig,
    ...(maxRunInputTokens === undefined ? {} : { maxRunInputTokens }),
    ...(opts.maxIterations === undefined ? {} : { maxIterations: opts.maxIterations }),
  };
  return {
    run: () =>
      engine.run(
        config,
        "",
        [{ role: "user", content: [{ type: "text", text: "Score 12 items" }] }],
        tools,
      ),
    modelCalls: () => calls,
    reminded,
    toolRuns,
    events,
  };
}

describe("AgentEngine run input cap", () => {
  it("stops before the call that would pass the cap, with stopReason max_input_tokens", async () => {
    const r = growingRun(6_500);
    const result = await r.run();

    // Calls 1–3 spend 6,000. Call 4 is projected at 3,000 (the previous call's
    // size outweighs the tiny prompt estimate), which passes 6,500, so it never starts.
    expect(result.stopReason).toBe("max_input_tokens");
    expect(r.modelCalls()).toBe(3);
    expect(result.usage.inputTokens).toBe(6_000);
    expect(result.usage.inputTokens).toBeLessThanOrEqual(6_500);
    expect(result.iterations).toBe(3);
    // Every call that ran had its tools executed; nothing was dropped.
    expect(r.toolRuns).toEqual(["call_1", "call_2", "call_3"]);

    const done = r.events.find((e) => e.type === "run.done");
    expect(done?.data.stopReason).toBe("max_input_tokens");
    expect(done?.data.iterations).toBe(3);
  });

  it("projects the next call from the prompt about to be sent, not only the previous call", async () => {
    // The provider reports a tiny input for call 1, but the tool result it
    // triggers is ~10K tokens, so call 2's prompt alone passes a 5,000 cap.
    // The previous call's 10 tokens would have let it through.
    let calls = 0;
    const model = createMockModel(() => {
      calls++;
      if (calls === 1) {
        return {
          content: [
            { type: "tool-call", toolCallId: "call_1", toolName: "test__score", input: "{}" },
          ],
          inputTokens: 10,
          outputTokens: 5,
        };
      }
      return { content: [{ type: "text", text: "done" }], inputTokens: 10, outputTokens: 5 };
    });
    const engine = new AgentEngine(
      model,
      new StaticToolRouter(
        tools,
        (): ToolResult => ({ content: textContent("x".repeat(40_000)), isError: false }),
      ),
      { emit() {} },
    );
    const result = await engine.run(
      { ...baseConfig, maxRunInputTokens: 5_000 },
      "",
      [{ role: "user", content: [{ type: "text", text: "Score 12 items" }] }],
      tools,
    );

    expect(result.stopReason).toBe("max_input_tokens");
    expect(calls).toBe(1);
    expect(result.usage.inputTokens).toBe(10);
  });

  it("runs to completion when no cap is set", async () => {
    const r = growingRun();
    const result = await r.run();

    expect(result.stopReason).toBe("complete");
    expect(r.modelCalls()).toBe(5);
    expect(result.usage.inputTokens).toBe(15_000);
    expect(result.output).toContain("all items scored");
  });

  it("runs to completion when the cap is larger than the run", async () => {
    const r = growingRun(1_000_000);
    const result = await r.run();

    expect(result.stopReason).toBe("complete");
    expect(r.modelCalls()).toBe(5);
    expect(result.usage.inputTokens).toBe(15_000);
  });

  it("runs to completion when the cap equals what the run spends", async () => {
    // The last check is 10,000 spent + 4,000 projected = 14,000 ≤ 15,000; the
    // final call then spends 5,000 and lands exactly on the cap.
    const r = growingRun(15_000);
    const result = await r.run();

    expect(result.stopReason).toBe("complete");
    expect(result.usage.inputTokens).toBe(15_000);
  });
});

describe("AgentEngine final-step reminder before the run input cap", () => {
  // With a 6,500 cap: before call 2, 1,000 spent + 2 × 1,000 projected = 3,000
  // fits; before call 3, 3,000 + 2 × 2,000 = 7,000 does not, so call 3 is the
  // last one the cap is likely to allow and carries the reminder. Call 4
  // (6,000 + 3,000 projected) would pass the cap outright.
  it("adds the reminder on the call before the cap would stop the run, and on no earlier call", async () => {
    const r = growingRun(6_500);
    await r.run();

    expect(r.reminded).toEqual([false, false, true]);
  });

  it("lets a model that heeds the reminder end the run complete, with its answer", async () => {
    const r = growingRun(6_500, { answerOnReminder: true });
    const result = await r.run();

    expect(result.stopReason).toBe("complete");
    expect(r.modelCalls()).toBe(3);
    expect(result.output).toContain("partial: some items scored");
    expect(result.usage.inputTokens).toBeLessThanOrEqual(6_500);
  });

  it("still stops with max_input_tokens when the model ignores the reminder", async () => {
    const r = growingRun(6_500);
    const result = await r.run();

    expect(result.stopReason).toBe("max_input_tokens");
    expect(r.modelCalls()).toBe(3);
    expect(result.usage.inputTokens).toBe(6_000);
  });

  it("adds no reminder when no cap is set", async () => {
    const r = growingRun();
    await r.run();

    expect(r.reminded).toEqual([false, false, false, false, false]);
  });

  it("adds no reminder when the cap is far above the run", async () => {
    const r = growingRun(1_000_000);
    await r.run();

    expect(r.reminded.every((x) => !x)).toBe(true);
  });

  it("still adds the reminder on the last allowed iteration when the cap is far away", async () => {
    const r = growingRun(1_000_000, { maxIterations: 3 });
    const result = await r.run();

    expect(result.stopReason).toBe("max_iterations");
    expect(r.reminded).toEqual([false, false, true]);
  });
});
