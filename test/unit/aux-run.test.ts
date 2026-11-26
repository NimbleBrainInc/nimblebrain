import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "../../src/engine/types.ts";
import type { AgentRuntime, ResolvedRun, RunIO } from "../../src/execution/types.ts";
import { completeOnRuntime } from "../../src/runtime/aux-run.ts";

/** A runtime that answers every run with `answer`, reporting one model call as `reported`. */
function answering(answer: string, reported?: string) {
  const seen: { run?: ResolvedRun; tools?: number } = {};
  const runtime: AgentRuntime = {
    id: "own",
    capabilities: {
      spendGate: false,
      usage: "reported",
      promotesTools: false,
      ownModel: "own-sub",
    },
    async execute(run: ResolvedRun, io: RunIO) {
      seen.run = run;
      seen.tools = (await io.tools.availableTools()).length;
      const usage = { inputTokens: 12, outputTokens: 3 };
      if (reported) {
        const done: EngineEvent = {
          type: "llm.done",
          data: {
            runId: run.runId,
            model: reported,
            content: [],
            usage,
            llmMs: 0,
            ttftMs: null,
            estimatedInputTokens: 0,
            finishReason: "stop",
          },
        };
        io.events.emit(done);
      }
      return {
        output: answer,
        toolCalls: [],
        iterations: 1,
        usage,
        llmMs: 0,
        stopReason: "complete",
      };
    },
  };
  return { runtime, seen };
}

describe("completeOnRuntime", () => {
  test("runs the door's work as a one-iteration run with no tools and no conversation", async () => {
    const { runtime, seen } = answering("Quarterly Plan Review", "own-sub:model-x");
    const out = await completeOnRuntime(
      runtime,
      "own-sub",
    )({
      system: "Title it.",
      text: "transcript",
      maxOutputTokens: 30,
      signal: new AbortController().signal,
    });
    expect(out).toEqual({
      text: "Quarterly Plan Review",
      usage: { inputTokens: 12, outputTokens: 3 },
      model: "own-sub:model-x",
    });
    expect(seen.run).toMatchObject({
      conversationId: null,
      system: "Title it.",
      tools: [],
      config: { model: "own-sub", maxIterations: 1, maxOutputTokens: 30 },
    });
    expect(seen.tools).toBe(0);
  });

  test("names the runtime's own model when the agent reported none", async () => {
    const { runtime } = answering("ok");
    const out = await completeOnRuntime(
      runtime,
      "own-sub",
    )({
      system: "s",
      text: "t",
      maxOutputTokens: 10,
      signal: new AbortController().signal,
    });
    expect(out.model).toBe("own-sub");
  });
});
