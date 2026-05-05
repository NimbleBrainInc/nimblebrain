import { describe, expect, test } from "bun:test";
import type {
  LanguageModelV3,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { AgentEngine } from "../../src/engine/engine.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import type { EngineConfig, EngineEvent, EventSink } from "../../src/engine/types.ts";
import { estimateCost } from "../../src/usage/cost.ts";

/**
 * Regression test for the bug fixed in PR #151 (issue #140).
 *
 * The engine must propagate the FULL token usage shape — including
 * cacheWriteTokens and reasoningTokens — through the llm.done event and
 * EngineResult.usage so the API boundary can compute correct cost.
 *
 * Before the unification, runtime.ts:898 called estimateCost with only
 * inputTokens/outputTokens/cacheReadTokens, silently dropping cacheWrite
 * (under-billing cache writes) and reasoning (mis-billing reasoning).
 *
 * The TokenUsage struct + single estimateCost(model, usage) signature
 * makes that class of bug a compile error, but this test pins the
 * behavior end-to-end so a future shape change can't quietly break it.
 */

const config: EngineConfig = {
  model: "anthropic:claude-sonnet-4-6",
  maxIterations: 3,
  maxOutputTokens: 100,
  thinking: { mode: "off" },
};

/** A model that returns a fixed usage shape including cache writes. */
function modelWithUsage(usage: LanguageModelV3Usage): LanguageModelV3 {
  const finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: undefined };
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-cache-heavy",
    supportedUrls: {},

    async doGenerate() {
      return {
        content: [{ type: "text", text: "ok" }],
        finishReason,
        usage,
        warnings: [],
      };
    },

    async doStream() {
      const parts: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "ok" },
        { type: "text-end", id: "t0" },
        { type: "finish", usage, finishReason },
      ];
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      };
    },
  };
}

describe("usage pipeline — cache writes + reasoning round-trip end-to-end", () => {
  test("EngineResult.usage carries the full TokenUsage struct", async () => {
    // Realistic cache-heavy turn: 22K non-cached + 524K cache read + 141K
    // cache write input; 10.6K output (no reasoning split for this model).
    // inputTokens.total per AI SDK V3 is 22K + 524K + 141K = 687K.
    const model = modelWithUsage({
      inputTokens: { total: 687_000, noCache: 22_000, cacheRead: 524_000, cacheWrite: 141_000 },
      outputTokens: { total: 10_587, text: 10_587, reasoning: undefined },
    });

    const events: EngineEvent[] = [];
    const sink: EventSink = {
      emit(e) {
        events.push(e);
      },
    };

    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      sink,
    );

    const result = await engine.run(
      config,
      "",
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      [],
    );

    // Engine result carries the full canonical struct.
    expect(result.usage.inputTokens).toBe(687_000);
    expect(result.usage.outputTokens).toBe(10_587);
    expect(result.usage.cacheReadTokens).toBe(524_000);
    expect(result.usage.cacheWriteTokens).toBe(141_000);

    // The llm.done event payload exposes the same nested usage shape.
    const llmDone = events.find((e) => e.type === "llm.done");
    expect(llmDone).toBeDefined();
    const llmUsage = (llmDone!.data as Record<string, unknown>).usage as {
      inputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    expect(llmUsage.inputTokens).toBe(687_000);
    expect(llmUsage.cacheReadTokens).toBe(524_000);
    expect(llmUsage.cacheWriteTokens).toBe(141_000);
  });

  test("estimateCost on the propagated usage charges cache writes correctly", async () => {
    const model = modelWithUsage({
      inputTokens: { total: 687_000, noCache: 22_000, cacheRead: 524_000, cacheWrite: 141_000 },
      outputTokens: { total: 10_587, text: 10_587, reasoning: undefined },
    });

    const sink: EventSink = { emit() {} };
    const engine = new AgentEngine(
      model,
      new StaticToolRouter([], () => ({ content: textContent(""), isError: false })),
      sink,
    );

    const result = await engine.run(
      config,
      "",
      [{ role: "user", content: [{ type: "text", text: "Hi" }] }],
      [],
    );

    // The API boundary calls estimateCost(model, usage). Cache writes must
    // bill at the cacheWrite rate (NOT silently fall through to the input
    // rate) and the non-cached input portion must NOT be double-counted.
    const cost = estimateCost(config.model, result.usage);

    // Compute expected cost from the Sonnet 4-6 catalog rates manually so
    // a rate change won't silently mask a regression — we'll detect it as
    // a hard-coded number drifting.
    // Per src/model/catalog-data.json (Anthropic Sonnet 4-6):
    //   input $3/M, output $15/M, cacheRead $0.30/M, cacheWrite $3.75/M
    const expected =
      (22_000 * 3 + 10_587 * 15 + 524_000 * 0.3 + 141_000 * 3.75) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 6);

    // Sanity floor: pre-fix code would charge 687K at full input rate AND
    // cache rates, ~3x the correct figure. Post-fix should be ~$0.85, far
    // less than the pre-fix ~$2.49 ceiling.
    expect(cost).toBeLessThan(1.0);
    expect(cost).toBeGreaterThan(0.5);
  });
});
