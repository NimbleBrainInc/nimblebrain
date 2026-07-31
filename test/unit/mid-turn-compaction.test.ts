import type { LanguageModelV3, LanguageModelV3Message } from "@ai-sdk/provider";
import { describe, expect, it } from "bun:test";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { StaticToolRouter } from "../../src/adapters/static-router.ts";
import { compactConversationMessages } from "../../src/conversation/compaction.ts";
import type { HistoryCompactedEvent, StoredMessage } from "../../src/conversation/types.ts";
import { textContent } from "../../src/engine/content-helpers.ts";
import { AgentEngine } from "../../src/engine/engine.ts";
import type { EngineConfig, ToolSchema } from "../../src/engine/types.ts";
import { buildMidTurnCompaction } from "../../src/runtime/mid-turn-compaction.ts";
import { createEchoModel, type EchoModelResponse } from "../helpers/echo-model.ts";

/**
 * The unit under test is the pair: the engine's `rewriteHistory` seam and the
 * runtime policy that drives it. Both sides of the loop are real — the real
 * agent loop, the real compaction module — with the summarizer stubbed, so what
 * the assertions read is the actual message sequence sent to the model on each
 * iteration.
 */

// Small enough that a handful of tool results crosses it. Trigger is 0.7×,
// keep is 0.35× (compaction defaults).
const BUDGET = 4_000;
const SUMMARY = "SUMMARY OF EARLIER WORK";

const config: EngineConfig = {
  model: "test-model",
  maxIterations: 12,
  maxInputTokens: BUDGET,
  maxOutputTokens: 4_096,
};

const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

/** `pairs` user+assistant turns of `chars` each, timestamped like stored ones. */
function openingHistory(pairs: number, chars: number): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (let i = 0; i < pairs; i++) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: "u".repeat(chars) }],
      timestamp: ts(i * 2),
    });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "a".repeat(chars) }],
      timestamp: ts(i * 2 + 1),
    });
  }
  return messages;
}

/** The engine takes plain model messages — the platform extras are stripped. */
function asModelMessages(history: StoredMessage[]): LanguageModelV3Message[] {
  return history.map(({ role, content }) => ({ role, content }) as LanguageModelV3Message);
}

/** Summarizer stand-in: one fixed text block, no network. */
const summarizer = {
  doGenerate: async () => ({ content: [{ type: "text", text: SUMMARY }] }),
} as unknown as LanguageModelV3;

/**
 * `Runtime.maybeCompactHistory`'s contract in test form: fold through the real
 * compaction module, report a no-op as `null`. `persisted` collects what the
 * runtime would append to the conversation's event log.
 */
function foldWithRealCompaction(persisted: HistoryCompactedEvent[]) {
  const seen: number[] = [];
  const compact = async (history: StoredMessage[]): Promise<StoredMessage[] | null> => {
    seen.push(history.length);
    const out = await compactConversationMessages(summarizer, history, {
      budget: BUDGET,
      now: ts(600),
      onEvent: (event) => persisted.push(event),
    });
    return out === history ? null : out;
  };
  return { compact, seen };
}

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
  const responses: EchoModelResponse[] = [];
  for (let i = 0; i < n; i++) {
    responses.push({
      toolCalls: [{ toolCallId: `call-${i}`, toolName: "search", input: "{}" }],
    });
  }
  responses.push({ text: "done" });
  return responses;
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

/** Does this call's prompt carry the folded summary? */
const carriesSummary = (prompt: LanguageModelV3Message[]) => JSON.stringify(prompt).includes(SUMMARY);

describe("mid-turn compaction", () => {
  it("test_long_tool_calling_turn_compacts_between_iterations", async () => {
    // Opens at ~1,800 tokens — under the 2,800-token trigger, so turn setup
    // would not have compacted. Each iteration then appends a ~750-token tool
    // result, and the turn crosses the trigger while the loop is still running.
    const history = openingHistory(6, 600);
    const persisted: HistoryCompactedEvent[] = [];
    const { compact, seen } = foldWithRealCompaction(persisted);
    const { model, prompts } = recordingEcho(toolThenAnswer(5));

    const result = await engineWith(model, 3_000).run(
      {
        ...config,
        hooks: {
          rewriteHistory: buildMidTurnCompaction({
            budget: BUDGET,
            initialTimestamps: history.map((m) => m.timestamp),
            compact,
          }),
        },
      },
      "sys",
      asModelMessages(history),
      [TOOL],
    );

    expect(result.stopReason).toBe("complete");
    // Folded once, mid-turn, and the run kept going on the compacted history.
    expect(seen).toHaveLength(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.summary).toBe(SUMMARY);
    // The boundary is a real message timestamp — a blank one would replay as
    // the summary plus the entire history it was supposed to replace.
    expect(persisted[0]?.compactedThroughTs).toBe(ts(10));

    const firstFolded = prompts.findIndex(carriesSummary);
    expect(firstFolded).toBeGreaterThan(0);
    expect(firstFolded).toBeLessThan(prompts.length - 1);
    // Every later call runs on the folded history, not just the one that folded.
    expect(prompts.slice(firstFolded).every(carriesSummary)).toBe(true);
    // And the fold actually shrank the prompt.
    const sizeOf = (i: number) => JSON.stringify(prompts[i]).length;
    expect(sizeOf(firstFolded)).toBeLessThan(sizeOf(firstFolded - 1));
  });

  it("test_short_turn_does_not_compact", async () => {
    // Same policy, a turn that stays well inside its budget: no fold, no
    // summarizer call, no event.
    const history = openingHistory(2, 200);
    const persisted: HistoryCompactedEvent[] = [];
    const { compact, seen } = foldWithRealCompaction(persisted);
    const { model, prompts } = recordingEcho(toolThenAnswer(2));

    const result = await engineWith(model, 200).run(
      {
        ...config,
        hooks: {
          rewriteHistory: buildMidTurnCompaction({
            budget: BUDGET,
            initialTimestamps: history.map((m) => m.timestamp),
            compact,
          }),
        },
      },
      "sys",
      asModelMessages(history),
      [TOOL],
    );

    expect(result.stopReason).toBe("complete");
    expect(seen).toEqual([]);
    expect(persisted).toEqual([]);
    expect(prompts.some(carriesSummary)).toBe(false);
  });

  it("test_opening_history_is_not_recompacted_before_the_first_call", async () => {
    // An already-over-budget opening history is turn setup's business: the loop
    // has added nothing yet, so re-deciding it here would only duplicate that
    // call's work. A turn that never iterates therefore never folds.
    const history = openingHistory(40, 600);
    const persisted: HistoryCompactedEvent[] = [];
    const { compact, seen } = foldWithRealCompaction(persisted);
    const { model } = recordingEcho([{ text: "done" }]);

    await engineWith(model, 100).run(
      {
        ...config,
        hooks: {
          rewriteHistory: buildMidTurnCompaction({
            budget: BUDGET,
            initialTimestamps: history.map((m) => m.timestamp),
            compact,
          }),
        },
      },
      "sys",
      asModelMessages(history),
      [TOOL],
    );

    expect(seen).toEqual([]);
    expect(persisted).toEqual([]);
  });

  it("test_failed_fold_is_not_retried_for_the_rest_of_the_turn", async () => {
    // Compaction is best-effort: a summarizer failure falls back to the full
    // history. The threshold stays crossed for every remaining iteration, so
    // without the latch each one would spend another summarizer call to fail
    // the same way.
    const history = openingHistory(6, 600);
    let attempts = 0;
    const compact = async (): Promise<StoredMessage[] | null> => {
      attempts++;
      return null;
    };
    const { model, prompts } = recordingEcho(toolThenAnswer(6));

    await engineWith(model, 3_000).run(
      {
        ...config,
        hooks: {
          rewriteHistory: buildMidTurnCompaction({
            budget: BUDGET,
            initialTimestamps: history.map((m) => m.timestamp),
            compact,
          }),
        },
      },
      "sys",
      asModelMessages(history),
      [TOOL],
    );

    expect(prompts.length).toBeGreaterThan(3);
    expect(attempts).toBe(1);
  });
});
