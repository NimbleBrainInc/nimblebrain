import type { LanguageModelV3, LanguageModelV3Message } from "@ai-sdk/provider";
import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { estimateMessagesTokens } from "../../src/conversation/compaction.ts";
import type { StoredMessage } from "../../src/conversation/types.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { AgentEngine } from "../../src/engine/engine.ts";
import { estimateMessageTokens } from "../../src/engine/token-estimate.ts";
import type { EngineConfig, EngineHooks, ToolSchema } from "../../src/engine/types.ts";
import {
  buildMidTurnCompaction,
  planMidTurnFold,
} from "../../src/runtime/mid-turn-compaction.ts";
import { createEchoModel, type EchoModelResponse } from "../helpers/echo-model.ts";

/**
 * The unit under test is the pair: the engine's `rewriteHistory` seam and the
 * runtime policy that drives it. Both sides of the loop are real — the real
 * agent loop, the real compaction primitives — with only the summarizer
 * stubbed, so what the assertions read is the message sequence actually sent to
 * the model on each iteration.
 */

// Small enough that a few tool results cross it. Trigger 0.7×, keep 0.35×.
const BUDGET = 4_000;
const SUMMARY = "SUMMARY OF EARLIER WORK";

const config: EngineConfig = {
  model: "test-model",
  maxIterations: 12,
  maxInputTokens: BUDGET,
  maxOutputTokens: 4_096,
};

/**
 * `pairs` prior user+assistant turns of `chars` each, then the user message
 * that opens this turn — the shape the engine is always handed, and the reason
 * a well-formed history alternates right up to where the loop starts appending.
 */
function openingHistory(pairs: number, chars: number): LanguageModelV3Message[] {
  const messages: LanguageModelV3Message[] = [];
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: "u".repeat(chars) }] });
    messages.push({ role: "assistant", content: [{ type: "text", text: "a".repeat(chars) }] });
  }
  messages.push({ role: "user", content: [{ type: "text", text: "go".repeat(chars / 2) }] });
  return messages;
}

const sizeOf = (messages: readonly LanguageModelV3Message[]) =>
  messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);

/** Echo model that also records the prompt it was called with. */
function recordingEcho(responses: EchoModelResponse[]) {
  const inner = createEchoModel({ responses });
  const prompts: LanguageModelV3Message[][] = [];
  const model: LanguageModelV3 = {
    ...inner,
    doStream: (options) => {
      prompts.push(options.prompt as LanguageModelV3Message[]);
      return inner.doStream(options);
    },
  };
  return { model, prompts };
}

const TOOL: ToolSchema = {
  name: "search",
  description: "search",
  inputSchema: { type: "object", properties: {} },
};

/** `n` tool-calling responses, then a plain answer. */
function toolThenAnswer(n: number): EchoModelResponse[] {
  const responses: EchoModelResponse[] = Array.from({ length: n }, (_, i) => ({
    toolCalls: [{ toolCallId: `call-${i}`, toolName: "search", input: "{}" }],
  }));
  return [...responses, { text: "done" }];
}

function engineWith(model: LanguageModelV3, resultChars: number) {
  return new AgentEngine(
    model,
    new StaticToolRouter([TOOL], () => ({
      content: textContent("r".repeat(resultChars)),
      isError: false,
    })),
    new NoopEventSink(),
  );
}

/** Count the summarizer calls a turn makes, and answer each with a fixed summary. */
function countingSummarizer() {
  const folded: number[] = [];
  const summarize = async (messages: LanguageModelV3Message[]) => {
    folded.push(messages.length);
    return SUMMARY;
  };
  return { summarize, folded };
}

const carriesSummary = (prompt: LanguageModelV3Message[]) =>
  JSON.stringify(prompt).includes(SUMMARY);

/** The summary seed is a user turn, so a folded history must still alternate. */
const alternates = (prompt: LanguageModelV3Message[]) =>
  prompt.every((m, i) => i === 0 || m.role !== "assistant" || prompt[i - 1]?.role !== "assistant");

async function runTurn(
  history: LanguageModelV3Message[],
  responses: EchoModelResponse[],
  resultChars: number,
  hooks?: EngineHooks,
) {
  const { model, prompts } = recordingEcho(responses);
  const result = await engineWith(model, resultChars).run(
    { ...config, ...(hooks ? { hooks } : {}) },
    "sys",
    history,
    [TOOL],
  );
  return { result, prompts };
}

/** One loop step: a tool-calling assistant message plus its result. */
function step(id: string, resultChars: number): LanguageModelV3Message[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName: "search", input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "search",
          output: { type: "text", value: "r".repeat(resultChars) },
        },
      ],
    },
  ];
}

describe("mid-turn compaction", () => {
  it("test_long_tool_calling_turn_folds_repeatedly_and_stays_bounded", async () => {
    // Opens at ~1,800 tokens — under the 2,800 trigger, so turn setup would not
    // have compacted. Each iteration then appends a ~750-token tool result.
    const opening = () => openingHistory(6, 600);
    const responses = () => toolThenAnswer(8);

    // Control: the same turn with no policy installed. This is the bug.
    const control = await runTurn(opening(), responses(), 3_000);
    const controlPeak = Math.max(...control.prompts.map(sizeOf));
    expect(controlPeak).toBeGreaterThan(BUDGET);

    const { summarize, folded } = countingSummarizer();
    const { prompts } = await runTurn(opening(), responses(), 3_000, {
      rewriteHistory: buildMidTurnCompaction({ budget: BUDGET, summarize }),
    });

    // Folds more than once in the turn: the whole point — a policy that can
    // only cut in front of the growth folds the opening history and then
    // watches the rest of the turn grow past it.
    expect(folded.length).toBeGreaterThan(1);
    // And every call stays inside the budget the turn was composed against.
    expect(Math.max(...prompts.map(sizeOf))).toBeLessThan(BUDGET);

    const firstFolded = prompts.findIndex(carriesSummary);
    expect(firstFolded).toBeGreaterThan(0);
    // Every later call runs on a folded history, not just the one that folded.
    expect(prompts.slice(firstFolded).every(carriesSummary)).toBe(true);
    // The seed carries an acknowledgement only when the kept tail opens on a
    // user message; a provider rejects the doubled assistant turn otherwise.
    expect(prompts.every(alternates)).toBe(true);
  });

  it("test_short_turn_does_not_fold", async () => {
    const { summarize, folded } = countingSummarizer();
    const { prompts } = await runTurn(openingHistory(2, 200), toolThenAnswer(2), 200, {
      rewriteHistory: buildMidTurnCompaction({ budget: BUDGET, summarize }),
    });

    expect(folded).toEqual([]);
    expect(prompts.some(carriesSummary)).toBe(false);
  });

  it("test_hook_is_gated_on_the_iteration_counter_and_carries_the_run_signal", async () => {
    // An already-over-budget opening history is turn setup's business: the loop
    // has added nothing yet. So the gate is the iteration counter, not the size
    // of the history — a turn that never iterates never folds, however large.
    const seen: Array<{ iteration: number; hasSignal: boolean }> = [];
    const hooks: EngineHooks = {
      rewriteHistory: async (_messages, opts) => {
        seen.push({ iteration: opts.iteration, hasSignal: opts.signal !== undefined });
        return null;
      },
    };

    const controller = new AbortController();
    const { model } = recordingEcho([{ text: "done" }]);
    await engineWith(model, 100).run(
      { ...config, hooks, signal: controller.signal },
      "sys",
      openingHistory(40, 600),
      [TOOL],
    );
    expect(seen).toEqual([]);

    const twoIterations = recordingEcho(toolThenAnswer(2));
    await engineWith(twoIterations.model, 100).run(
      { ...config, hooks, signal: controller.signal },
      "sys",
      openingHistory(1, 100),
      [TOOL],
    );
    // First consulted after the first iteration completes, then every one after.
    expect(seen.map((s) => s.iteration)).toEqual([1, 2]);
    // The run's signal reaches the hook, so a fold in flight cancels with the
    // turn instead of holding it open for the summarizer's own timeout.
    expect(seen.every((s) => s.hasSignal)).toBe(true);
  });

  it("test_seed_alternates_whichever_role_the_kept_tail_opens_on", async () => {
    const { summarize } = countingSummarizer();
    const fold = buildMidTurnCompaction({ budget: BUDGET, summarize });

    // A tail opening on a user turn needs the seed's acknowledgement between
    // the summary turn and it. That is the ordinary case: the kept tail is this
    // turn, which starts at the user message that opened it.
    const bigOpeningTurn: LanguageModelV3Message[] = [
      ...openingHistory(40, 400).slice(0, -1), // prior turns only
      { role: "user", content: [{ type: "text", text: "q".repeat(6_000) }] },
      ...step("c0", 200),
    ];
    const openingOnUser = await fold(bigOpeningTurn, { iteration: 1 });
    expect(openingOnUser?.[2]?.role).toBe("user");
    expect(openingOnUser?.[1]?.role).toBe("assistant");
    expect(JSON.stringify(openingOnUser?.slice(0, 2))).toContain("Understood");
    expect(alternates(openingOnUser as LanguageModelV3Message[])).toBe(true);

    // A tail opening on an assistant turn already alternates against the
    // summary turn, so the acknowledgement is dropped rather than doubling it.
    const grown = [
      ...openingHistory(2, 400),
      ...Array.from({ length: 8 }, (_, i) => step(`c${i}`, 3_000)).flat(),
    ];
    const openingOnAssistant = await fold(grown, { iteration: 2 });
    expect(openingOnAssistant?.[1]?.role).toBe("assistant");
    expect(JSON.stringify(openingOnAssistant?.slice(0, 2))).not.toContain("Understood");
    expect(alternates(openingOnAssistant as LanguageModelV3Message[])).toBe(true);
  });

  it("test_failed_fold_is_not_retried_for_the_rest_of_the_turn", async () => {
    // Compaction is best-effort: a summarizer failure falls back to the full
    // history. The threshold stays crossed for every remaining iteration, so
    // without the latch each one would spend another summarizer call to fail
    // the same way.
    let attempts = 0;
    const summarize = async () => {
      attempts++;
      throw new Error("summarizer unavailable");
    };

    const { result, prompts } = await runTurn(openingHistory(6, 600), toolThenAnswer(6), 3_000, {
      rewriteHistory: buildMidTurnCompaction({ budget: BUDGET, summarize }),
    });

    // The turn completes on the full history — a failed fold is not a failed turn.
    expect(result.stopReason).toBe("complete");
    expect(prompts.length).toBeGreaterThan(3);
    expect(attempts).toBe(1);
  });
});

describe("planMidTurnFold", () => {
  it("test_cut_never_orphans_a_tool_result_from_its_call", () => {
    const history = [
      ...openingHistory(2, 400),
      ...Array.from({ length: 8 }, (_, i) => step(`c${i}`, 3_000)).flat(),
    ];
    const cut = planMidTurnFold(history, BUDGET);
    expect(cut).not.toBeNull();
    // The kept tail opens on a whole group, so no tool result is left behind
    // without the assistant message that called for it.
    expect(history[cut as number]?.role).not.toBe("tool");
  });

  it("test_attachment_bytes_do_not_trigger_a_fold", () => {
    // An in-flight history is rehydrated, so an attachment is a file part
    // holding raw bytes (src/files/rehydrate.ts). Sizing it by the length of
    // its JSON reads those bytes as a `{"0":..,"1":..}` object — hundreds of
    // times the tokens the image actually costs — and folds a conversation
    // that is nowhere near its budget.
    const history: LanguageModelV3Message[] = [
      ...openingHistory(3, 40),
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this" },
          {
            type: "file",
            mediaType: "image/png",
            data: new Uint8Array(700_000),
            filename: "shot.png",
          },
        ],
      },
      ...openingHistory(3, 40),
    ];

    expect(sizeOf(history)).toBeLessThan(BUDGET);
    expect(planMidTurnFold(history, BUDGET)).toBeNull();
    // Pinned against the estimator this policy must not use: chars-over-JSON
    // calls the same history hundreds of budgets' worth of tokens.
    expect(estimateMessagesTokens(history as unknown as StoredMessage[])).toBeGreaterThan(
      100 * BUDGET,
    );
  });
});
