import { describe, expect, test } from "bun:test";
import type {
  ContextAssembledEvent,
  ConversationEvent,
  LlmResponseEvent,
  RunStartEvent,
} from "../../src/conversation/types.ts";
import { CUT_OFF_FINISH_RAW } from "../../src/engine/types.ts";
import { tokenEstimateCorrection } from "../../src/runtime/token-estimate-correction.ts";

const MODEL = "anthropic:claude-sonnet-4-6";
const RUN = "run_previous";
const TS = "2026-11-15T00:00:00.000Z";

function start(runId = RUN, model = MODEL): RunStartEvent {
  return { ts: TS, type: "run.start", runId, model };
}

function context(
  runId = RUN,
  sources: ContextAssembledEvent["sources"] = [
    { kind: "system_prompt", tokens: 100 },
    { kind: "tool_descriptions", tokens: 50 },
    { kind: "skills", tokens: 100 },
    { kind: "history", tokens: 50 },
  ],
): ContextAssembledEvent {
  return {
    ts: TS,
    type: "context.assembled",
    runId,
    sources,
    excluded: [],
    totalTokens: sources.reduce((sum, source) => sum + source.tokens, 0),
  };
}

function response(inputTokens: number, runId = RUN, model = MODEL): LlmResponseEvent {
  return {
    ts: TS,
    type: "llm.response",
    runId,
    model,
    content: [],
    usage: { inputTokens, outputTokens: 1 },
    llmMs: 1,
    finishReason: "stop",
  };
}

describe("tokenEstimateCorrection", () => {
  test("uses disjoint prompt rows rather than totalTokens, which counts skills twice", () => {
    // 100 system + 50 tools + 50 history = 200. The skills row overlaps system,
    // making totalTokens 300; using that would clamp 240/300 down to 1.0.
    expect(tokenEstimateCorrection([start(), context(), response(240)], MODEL)).toBe(1.2);
  });

  test("pairs the snapshot with the first response of a multi-iteration run", () => {
    const events: ConversationEvent[] = [start(), context(), response(220), response(300)];
    expect(tokenEstimateCorrection(events, MODEL)).toBe(1.1);
  });

  test("uses only the immediately preceding run and the same model", () => {
    const otherModel = "openai:gpt-5";
    expect(
      tokenEstimateCorrection(
        [
          start("run_older"),
          context("run_older"),
          response(240, "run_older"),
          start(RUN, otherModel),
        ],
        MODEL,
      ),
    ).toBe(1);
    expect(
      tokenEstimateCorrection([start(), context(), response(240, RUN, otherModel)], MODEL),
    ).toBe(1);
    expect(
      tokenEstimateCorrection(
        [start("run_older"), context("run_older"), response(240, "run_older"), start()],
        MODEL,
      ),
    ).toBe(1);
  });

  test("does not pair a snapshot or response from another run", () => {
    expect(tokenEstimateCorrection([start(), context("run_other"), response(240)], MODEL)).toBe(1);
    expect(tokenEstimateCorrection([start(), context(), response(240, "run_other")], MODEL)).toBe(
      1,
    );
  });

  test("falls back without a complete, positive measurement", () => {
    expect(tokenEstimateCorrection([], MODEL)).toBe(1);
    expect(tokenEstimateCorrection([start(), response(240)], MODEL)).toBe(1);
    expect(tokenEstimateCorrection([start(), context()], MODEL)).toBe(1);
    expect(tokenEstimateCorrection([start(), context(), response(0)], MODEL)).toBe(1);
    expect(tokenEstimateCorrection([start(), context(), response(0), response(300)], MODEL)).toBe(
      1,
    );
    expect(tokenEstimateCorrection([start(), context(), response(Number.NaN)], MODEL)).toBe(1);
    expect(tokenEstimateCorrection([start(), context(RUN, []), response(240)], MODEL)).toBe(1);
  });

  test("falls back when a persisted context or usage line has the wrong JSON shape", () => {
    const badContext = JSON.parse(
      JSON.stringify({ ...context(), sources: null }),
    ) as ContextAssembledEvent;
    const badSource = JSON.parse(
      JSON.stringify({ ...context(), sources: [null] }),
    ) as ContextAssembledEvent;
    const badUsage = JSON.parse(
      JSON.stringify({ ...response(240), usage: null }),
    ) as LlmResponseEvent;
    expect(tokenEstimateCorrection([start(), badContext, response(240)], MODEL)).toBe(1);
    expect(tokenEstimateCorrection([start(), badSource, response(240)], MODEL)).toBe(1);
    expect(tokenEstimateCorrection([start(), context(), badUsage], MODEL)).toBe(1);
  });

  test("does not mistake a cancelled call's estimated usage for provider measurement", () => {
    const cutOff = { ...response(240), finishReasonRaw: CUT_OFF_FINISH_RAW };
    expect(tokenEstimateCorrection([start(), context(), cutOff], MODEL)).toBe(1);
  });

  test("never expands the budget and caps an anomalous ratio", () => {
    expect(tokenEstimateCorrection([start(), context(), response(100)], MODEL)).toBe(1);
    expect(tokenEstimateCorrection([start(), context(), response(500)], MODEL)).toBe(1.5);
  });
});
