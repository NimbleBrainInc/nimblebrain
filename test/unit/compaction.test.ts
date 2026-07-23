import { describe, expect, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { reconstructMessages } from "../../src/conversation/event-reconstructor.ts";
import {
  compactConversationMessages,
  compactionSummaryMessages,
  estimateMessagesTokens,
  planCompaction,
  RETAINED_OPERATOR_MAX_TOKENS,
  type RetainedOperatorMessage,
  type RetainedOperatorSelection,
  runCompaction,
  selectRetainedOperatorMessages,
  summarizeMessages,
} from "../../src/conversation/compaction.ts";
import type {
  ConversationEvent,
  HistoryCompactedEvent,
  StoredMessage,
} from "../../src/conversation/types.ts";

// --- builders --------------------------------------------------------------

function user(text: string, ts: string): StoredMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: ts };
}
function assistant(text: string, ts: string): StoredMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: ts };
}
const ts = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

/** A conversation of `turns` user+assistant pairs, each ~`tokensEach`/2 tokens per message. */
function conversation(turns: number, charsPerMsg: number): StoredMessage[] {
  const msgs: StoredMessage[] = [];
  for (let i = 0; i < turns; i++) {
    msgs.push(user("u".repeat(charsPerMsg), ts(i * 2)));
    msgs.push(assistant("a".repeat(charsPerMsg), ts(i * 2 + 1)));
  }
  return msgs;
}

/** Minimal fake model whose doGenerate returns a fixed text block. */
function fakeModel(text: string): LanguageModelV3 {
  return {
    doGenerate: async () => ({ content: text ? [{ type: "text", text }] : [] }),
  } as unknown as LanguageModelV3;
}

// --- planCompaction --------------------------------------------------------

describe("planCompaction", () => {
  test("does not compact below the trigger threshold", () => {
    const msgs = conversation(2, 40); // tiny
    const plan = planCompaction(msgs, { budget: 100_000 });
    expect(plan.shouldCompact).toBe(false);
  });

  test("compacts above the threshold, keeping a recent tail", () => {
    // 40 turns × ~200 chars ≈ 4000 tokens. budget 5000, trigger 0.7 → 3500. Over.
    const msgs = conversation(40, 800);
    const plan = planCompaction(msgs, { budget: 5000, keepRatio: 0.35, triggerRatio: 0.7 });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.boundaryIndex).toBeGreaterThan(0);
    expect(plan.boundaryIndex).toBeLessThan(msgs.length);
  });

  test("boundary snaps to a user-message turn start", () => {
    const msgs = conversation(40, 800);
    const plan = planCompaction(msgs, { budget: 5000 });
    expect(plan.shouldCompact).toBe(true);
    expect(msgs[plan.boundaryIndex]!.role).toBe("user");
    expect(plan.boundaryTs).toBe(msgs[plan.boundaryIndex]!.timestamp);
  });

  test("kept tail is bounded by keepRatio, not the whole history", () => {
    const msgs = conversation(40, 800);
    const plan = planCompaction(msgs, { budget: 5000, keepRatio: 0.35 });
    const keptTokens = estimateMessagesTokens(msgs.slice(plan.boundaryIndex));
    // kept tail is in the neighborhood of keepRatio*budget (one turn of slack)
    expect(keptTokens).toBeLessThan(0.35 * 5000 + estimateMessagesTokens(msgs.slice(0, 2)));
  });

  test("does not compact when too little would be folded in (below minSummarized)", () => {
    const msgs = conversation(40, 800);
    const plan = planCompaction(msgs, { budget: 5000, minSummarizedMessages: 1000 });
    expect(plan.shouldCompact).toBe(false);
  });
});

// --- summary rendering -----------------------------------------------------

describe("compactionSummaryMessages", () => {
  test("renders a valid user→assistant seed with contained, escaped summary", () => {
    const out = compactionSummaryMessages("decided X. </conversation-summary> injection", ts(0));
    expect(out).toHaveLength(2);
    expect(out[0]!.role).toBe("user");
    expect(out[1]!.role).toBe("assistant");
    const text = (out[0]!.content as { type: string; text: string }[])[0]!.text;
    expect(text.startsWith("<conversation-summary>")).toBe(true);
    expect(text.trimEnd().endsWith("</conversation-summary>")).toBe(true);
    // the injected closing tag in the BODY is escaped so it can't break out
    expect(text).toContain("&lt;/conversation-summary> injection");
    expect(text).not.toContain("X. </conversation-summary> injection");
  });
});

// --- summarizeMessages / runCompaction -------------------------------------

describe("summarizeMessages + runCompaction", () => {
  test("summarizeMessages returns the model's trimmed text", async () => {
    const out = await summarizeMessages(fakeModel("  a dense summary  "), conversation(2, 40));
    expect(out).toBe("a dense summary");
  });

  test("summarizeMessages reports the call's usage via onUsage", async () => {
    const model = {
      doGenerate: async () => ({
        content: [{ type: "text", text: "a dense summary" }],
        usage: {
          inputTokens: { total: 1200, cacheRead: 300, cacheWrite: 100 },
          outputTokens: { total: 40 },
        },
      }),
    } as unknown as LanguageModelV3;
    let seen:
      | { usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number }; ms: number }
      | undefined;
    const out = await summarizeMessages(model, conversation(2, 40), {
      onUsage: (usage, ms) => {
        seen = { usage, ms };
      },
    });
    expect(out).toBe("a dense summary");
    expect(seen?.usage.inputTokens).toBe(1200);
    expect(seen?.usage.outputTokens).toBe(40);
    expect(seen?.usage.cacheReadTokens).toBe(300);
    expect(typeof seen?.ms).toBe("number");
  });

  test("summarizeMessages throws on an empty model response", async () => {
    await expect(summarizeMessages(fakeModel(""), conversation(2, 40))).rejects.toThrow();
  });

  test("transcript names tool calls and results so the summary can preserve them", async () => {
    // Regression: formatTranscript collapsed every non-text part to a bare
    // `[tool-call]` / `[tool-result]` placeholder, so the summarizer could not
    // honor its instruction to preserve "files/entities/tools touched".
    let captured = "";
    const capturing = {
      doGenerate: async (opts: { prompt: Array<{ role: string; content: unknown }> }) => {
        captured = JSON.stringify(opts.prompt.find((p) => p.role === "user")?.content ?? "");
        return { content: [{ type: "text", text: "summary" }] };
      },
    } as unknown as LanguageModelV3;

    const msgs = [
      user("look up the weather", ts(0)),
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "get_weather", input: { city: "Honolulu" } },
        ],
        timestamp: ts(1),
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "get_weather",
            output: { type: "text", value: "72F and sunny" },
          },
        ],
        timestamp: ts(2),
      },
    ] as StoredMessage[];

    await summarizeMessages(capturing, msgs);
    expect(captured).toContain("get_weather");
    expect(captured).toContain("Honolulu");
    expect(captured).toContain("72F and sunny");
  });

  test("runCompaction returns null below threshold (model never called)", async () => {
    let called = false;
    const model = { doGenerate: async () => ((called = true), { content: [] }) } as unknown as LanguageModelV3;
    const out = await runCompaction(model, conversation(2, 40), { budget: 100_000 });
    expect(out).toBeNull();
    expect(called).toBe(false);
  });

  test("runCompaction summarizes the pre-boundary slice and reports the boundary", async () => {
    const msgs = conversation(40, 800);
    const plan = planCompaction(msgs, { budget: 5000 });
    const out = await runCompaction(fakeModel("SUMMARY"), msgs, { budget: 5000 });
    expect(out).not.toBeNull();
    expect(out!.summary).toBe("SUMMARY");
    expect(out!.compactedThroughTs).toBe(plan.boundaryTs);
    expect(out!.summarizedMessageCount).toBe(plan.boundaryIndex);
  });
});

// --- summarizer context bounding (regression: large folds silently no-op'd) ---

/** Mimics the provider rejecting an over-context prompt, like the real API. */
function contextLimitedModel(summaryText: string, contextTokens: number): LanguageModelV3 {
  return {
    doGenerate: async (opts: { prompt: unknown }) => {
      const tokens = Math.ceil(JSON.stringify(opts.prompt).length / 4);
      if (tokens > contextTokens) {
        throw new Error(`prompt is too long: ${tokens} tokens > ${contextTokens} maximum`);
      }
      return { content: [{ type: "text", text: summaryText }] };
    },
  } as unknown as LanguageModelV3;
}

/** Records the prompt-token size the model was actually handed. */
function sizeCapturingModel(): { model: LanguageModelV3; lastPromptTokens: () => number } {
  let last = 0;
  const model = {
    doGenerate: async (opts: { prompt: unknown }) => {
      last = Math.ceil(JSON.stringify(opts.prompt).length / 4);
      return { content: [{ type: "text", text: "s" }] };
    },
  } as unknown as LanguageModelV3;
  return { model, lastPromptTokens: () => last };
}

describe("summarizeMessages — bounds the transcript to the summarizer context", () => {
  test("a fold far larger than the summarizer context is bounded under it", async () => {
    const fold = conversation(100, 4000); // ~200k tokens of fold
    const { model, lastPromptTokens } = sizeCapturingModel();
    await summarizeMessages(model, fold, { summarizerContextTokens: 50_000 });
    expect(lastPromptTokens()).toBeLessThanOrEqual(50_000);
  });

  test("a single message larger than the whole budget is truncated, not dropped or overflowed", async () => {
    const huge = user("X".repeat(2_000_000), ts(0)); // ~500k tokens in ONE message
    const { model, lastPromptTokens } = sizeCapturingModel();
    const out = await summarizeMessages(model, [huge], { summarizerContextTokens: 40_000 });
    expect(out).toBe("s"); // the call happened (didn't throw / infinite-loop)
    expect(lastPromptTokens()).toBeLessThanOrEqual(40_000);
  });
});

describe("compactConversationMessages — large fold + small summarizer (production regression)", () => {
  test("compacts instead of silently failing when the fold exceeds the summarizer context", async () => {
    // Repro of the prod bug: fold ≫ summarizer context. Old behavior: doGenerate
    // throws `prompt is too long`, best-effort swallows it, ZERO events, history
    // never bounded. New: the transcript is bounded so the call fits and a
    // history.compacted event is emitted.
    const msgs = conversation(120, 4000); // ~240k tokens of history
    const events: HistoryCompactedEvent[] = [];
    const errors: unknown[] = [];
    const out = await compactConversationMessages(contextLimitedModel("SUMMARY", 12_500), msgs, {
      budget: 100_000,
      summarizerContextTokens: 12_500, // tiny summarizer window
      now: ts(999),
      onEvent: (e) => events.push(e),
      onError: (e) => errors.push(e),
    });
    expect(errors).toEqual([]); // did NOT fall back on an over-context error
    expect(events).toHaveLength(1); // it actually compacted
    expect(out).not.toBe(msgs);
  });
});

// --- compactConversationMessages (the wiring helper) -----------------------

describe("compactConversationMessages", () => {
  test("compacts: emits one event and returns summary seed + kept tail", async () => {
    const msgs = conversation(40, 800);
    const events: HistoryCompactedEvent[] = [];
    const out = await compactConversationMessages(fakeModel("SUMMARY"), msgs, {
      budget: 5000,
      now: ts(99),
      onEvent: (e) => events.push(e),
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("history.compacted");
    expect(events[0]!.summary).toBe("SUMMARY");
    expect(events[0]!.ts).toBe(ts(99));
    // returns a NEW array: summary seed (2 msgs) + the kept tail
    expect(out).not.toBe(msgs);
    expect(out[0]!.role).toBe("user");
    expect((out[0]!.content as { text?: string }[])[0]?.text).toContain("SUMMARY");
    expect(out[1]!.role).toBe("assistant");
  });

  test("no-op below threshold: same reference, no event, model never called", async () => {
    const msgs = conversation(2, 40);
    let called = false;
    const model = { doGenerate: async () => ((called = true), { content: [] }) } as never;
    const events: HistoryCompactedEvent[] = [];
    const out = await compactConversationMessages(model, msgs, {
      budget: 100_000,
      now: ts(99),
      onEvent: (e) => events.push(e),
    });
    expect(out).toBe(msgs); // unchanged reference → caller detects no-op
    expect(events).toHaveLength(0);
    expect(called).toBe(false);
  });

  test("best-effort: a summarizer failure falls back to full history, no event", async () => {
    const msgs = conversation(40, 800);
    const model = {
      doGenerate: async () => {
        throw new Error("model boom");
      },
    } as never;
    const events: HistoryCompactedEvent[] = [];
    const out = await compactConversationMessages(model, msgs, {
      budget: 5000,
      now: ts(99),
      onEvent: (e) => events.push(e),
    });
    expect(out).toBe(msgs); // fell back to the full history
    expect(events).toHaveLength(0); // nothing persisted
  });
});

// --- reconstruction honors the compaction event ----------------------------

describe("reconstructMessages — history.compacted", () => {
  test("replaces pre-boundary turns with the summary seed and replays the tail", () => {
    const events: ConversationEvent[] = [
      { ts: ts(0), type: "user.message", content: [{ type: "text", text: "old turn 1" }] },
      { ts: ts(2), type: "user.message", content: [{ type: "text", text: "old turn 2" }] },
      { ts: ts(4), type: "user.message", content: [{ type: "text", text: "kept turn" }] },
      // appended AFTER the turns it summarizes; boundary = ts(4) (the kept turn)
      {
        ts: ts(9),
        type: "history.compacted",
        summary: "the user did two old things",
        compactedThroughTs: ts(4),
        summarizedMessageCount: 2,
      },
    ];
    const msgs = reconstructMessages(events);
    const firstText = (msgs[0]!.content as { text?: string }[])[0]?.text ?? "";
    expect(firstText).toContain("<conversation-summary>");
    expect(firstText).toContain("the user did two old things");
    expect(msgs[1]!.role).toBe("assistant"); // ack
    // Operator retention: the two pre-boundary USER turns are kept VERBATIM in
    // the summary seed's <operator-messages> block (not collapsed into prose),
    // so operator corrections survive compaction. They ride the seed rather than
    // replaying as standalone user turns.
    expect(firstText).toContain("<operator-messages>");
    expect(firstText).toContain("old turn 1");
    expect(firstText).toContain("old turn 2");
    expect(msgs).toHaveLength(3); // seed (user + assistant ack) + the kept turn
    // the kept turn survives verbatim in the tail
    expect(JSON.stringify(msgs)).toContain("kept turn");
  });

  test("uses only the most recent compaction when several accumulate", () => {
    const events: ConversationEvent[] = [
      { ts: ts(0), type: "user.message", content: [{ type: "text", text: "ancient" }] },
      { ts: ts(2), type: "user.message", content: [{ type: "text", text: "middle" }] },
      {
        ts: ts(3),
        type: "history.compacted",
        summary: "first summary",
        compactedThroughTs: ts(2),
        summarizedMessageCount: 1,
      },
      { ts: ts(4), type: "user.message", content: [{ type: "text", text: "recent" }] },
      {
        ts: ts(5),
        type: "history.compacted",
        summary: "second summary subsumes first",
        compactedThroughTs: ts(4),
        summarizedMessageCount: 2,
      },
    ];
    const msgs = reconstructMessages(events);
    const joined = JSON.stringify(msgs);
    // Latest-summary-wins for the NARRATIVE: only the second summary is used.
    expect(joined).toContain("second summary subsumes first");
    expect(joined).not.toContain("first summary");
    // Operator retention is derived fresh from the event log on each read, so
    // BOTH pre-boundary operator turns survive verbatim across the two
    // compactions — no summary-of-summary decay.
    expect(joined).toContain("ancient");
    expect(joined).toContain("middle");
    expect(joined).toContain("recent");
  });

  test("no compaction event → unchanged reconstruction", () => {
    const events: ConversationEvent[] = [
      { ts: ts(0), type: "user.message", content: [{ type: "text", text: "hi" }] },
    ];
    const msgs = reconstructMessages(events);
    expect((msgs[0]!.content as { text?: string }[])[0]?.text).toBe("hi");
  });

  test("aux.usage events are skipped — forked-call cost, never a message", () => {
    const events: ConversationEvent[] = [
      { ts: ts(0), type: "user.message", content: [{ type: "text", text: "hi" }] },
      {
        ts: ts(1),
        type: "aux.usage",
        source: "title",
        model: "m",
        usage: { inputTokens: 10, outputTokens: 5 },
        llmMs: 1,
      },
    ];
    const msgs = reconstructMessages(events);
    expect(msgs).toHaveLength(1);
    expect((msgs[0]!.content as { text?: string }[])[0]?.text).toBe("hi");
  });

  test("ignoreCompaction returns the full verbatim history (fork/UI projection)", () => {
    // The truth projection: every turn replays and the summary seed is absent.
    // This is what fork() and the web client must read — NOT the model view.
    const events: ConversationEvent[] = [
      { ts: ts(0), type: "user.message", content: [{ type: "text", text: "old turn 1" }] },
      { ts: ts(2), type: "user.message", content: [{ type: "text", text: "old turn 2" }] },
      { ts: ts(4), type: "user.message", content: [{ type: "text", text: "kept turn" }] },
      {
        ts: ts(9),
        type: "history.compacted",
        summary: "the user did two old things",
        compactedThroughTs: ts(4),
        summarizedMessageCount: 2,
      },
    ];
    const msgs = reconstructMessages(events, { ignoreCompaction: true });
    const allText = JSON.stringify(msgs);
    expect(allText).toContain("old turn 1");
    expect(allText).toContain("old turn 2");
    expect(allText).toContain("kept turn");
    expect(allText).not.toContain("<conversation-summary>");
    expect(allText).not.toContain("the user did two old things");
  });
});

// --- operator retention across compaction ----------------------------------
//
// The invariant: no operator-authored corrective instruction becomes
// unrecoverable within its own conversation. Operator (user-authored) messages
// are kept VERBATIM across compaction — and, because they're re-derived from the
// append-only event log rather than the summary, repeated compaction can't decay
// them (the observed production failure: corrections lost after ~6 compactions).

describe("selectRetainedOperatorMessages", () => {
  test("keeps only turns strictly before the boundary (the rest stay in the tail)", () => {
    const turns: RetainedOperatorMessage[] = [
      { text: "before A", ts: ts(0) },
      { text: "before B", ts: ts(2) },
      { text: "boundary turn", ts: ts(4) },
      { text: "after boundary", ts: ts(6) },
    ];
    const sel = selectRetainedOperatorMessages(turns, ts(4));
    expect(sel.kept.map((k) => k.text)).toEqual(["before A", "before B"]);
    expect(sel.elided).toBe(false);
  });

  test("skips empty/whitespace-only turns (attachment-only sends)", () => {
    const turns: RetainedOperatorMessage[] = [
      { text: "   ", ts: ts(0) },
      { text: "real correction", ts: ts(2) },
    ];
    const sel = selectRetainedOperatorMessages(turns, ts(10));
    expect(sel.kept.map((k) => k.text)).toEqual(["real correction"]);
  });

  test("bounds the block to the cap by keeping the NEWEST and eliding the oldest", () => {
    // Far more operator text than the cap fits.
    const turns: RetainedOperatorMessage[] = [];
    for (let i = 0; i < 500; i++) turns.push({ text: "X".repeat(2_000), ts: ts(i) });
    const sel = selectRetainedOperatorMessages(turns, ts(9999), RETAINED_OPERATOR_MAX_TOKENS);
    expect(sel.elided).toBe(true);
    const keptChars = sel.kept.reduce((n, k) => n + k.text.length, 0);
    expect(Math.ceil(keptChars / 4)).toBeLessThanOrEqual(RETAINED_OPERATOR_MAX_TOKENS);
    // newest kept: the last turn is present, the first is not
    expect(sel.kept.at(-1)!.ts).toBe(ts(499));
    expect(sel.kept[0]!.ts).not.toBe(ts(0));
  });

  test("a single turn larger than the whole cap is truncated, not dropped", () => {
    const turns: RetainedOperatorMessage[] = [
      { text: "Y".repeat(RETAINED_OPERATOR_MAX_TOKENS * 4 * 3), ts: ts(0) },
    ];
    const sel = selectRetainedOperatorMessages(turns, ts(10), RETAINED_OPERATOR_MAX_TOKENS);
    expect(sel.kept).toHaveLength(1); // kept, not dropped
    expect(Math.ceil(sel.kept[0]!.text.length / 4)).toBeLessThanOrEqual(RETAINED_OPERATOR_MAX_TOKENS);
  });

  test("counts the RENDERED (escaped) length so markup-heavy text can't blow the cap", () => {
    // Escaping expands </…→&lt;/… (+3 chars each). Raw-length accounting would
    // under-count a turn full of closing tags and let the rendered block exceed
    // the cap. Cost must be measured against the escaped form.
    const turns: RetainedOperatorMessage[] = [];
    for (let i = 0; i < 100; i++) turns.push({ text: "</tag>".repeat(2_000), ts: ts(i) });
    const sel = selectRetainedOperatorMessages(turns, ts(9_999), RETAINED_OPERATOR_MAX_TOKENS);
    // kept text is pre-escaped; the sum of rendered lines is within the cap.
    const renderedChars = sel.kept.reduce((n, k) => n + k.text.length + k.ts.length + 4, 0);
    expect(Math.ceil(renderedChars / 4)).toBeLessThanOrEqual(RETAINED_OPERATOR_MAX_TOKENS);
    expect(sel.elided).toBe(true);
    // no raw closing tag survives into the kept text
    expect(sel.kept.every((k) => !k.text.includes("</"))).toBe(true);
  });

  test("a single oversized markup-heavy turn truncates to fit the escaped cap", () => {
    const turns: RetainedOperatorMessage[] = [
      { text: "</x>".repeat(RETAINED_OPERATOR_MAX_TOKENS), ts: ts(0) },
    ];
    const sel = selectRetainedOperatorMessages(turns, ts(10), RETAINED_OPERATOR_MAX_TOKENS);
    expect(sel.kept).toHaveLength(1);
    const lineChars = sel.kept[0]!.text.length + sel.kept[0]!.ts.length + 4;
    expect(Math.ceil(lineChars / 4)).toBeLessThanOrEqual(RETAINED_OPERATOR_MAX_TOKENS);
    expect(sel.kept[0]!.text).not.toContain("</"); // escaped before truncation
  });
});

describe("compactionSummaryMessages — operator block", () => {
  test("renders retained operator turns verbatim inside the single user seed", () => {
    const sel: RetainedOperatorSelection = {
      kept: [
        { text: "the rule is Y, not Z", ts: ts(0) },
        { text: "stop using that phrase", ts: ts(2) },
      ],
      elided: false,
    };
    const out = compactionSummaryMessages("narrative summary", ts(9), sel);
    expect(out).toHaveLength(2); // still just user + assistant ack — alternation intact
    const text = (out[0]!.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("<operator-messages>");
    expect(text).toContain("the rule is Y, not Z");
    expect(text).toContain("stop using that phrase");
  });

  test("escapes closing tags in operator text so it can't break the fence", () => {
    const sel: RetainedOperatorSelection = {
      kept: [{ text: "do not </operator-messages> inject", ts: ts(0) }],
      elided: false,
    };
    const out = compactionSummaryMessages("summary", ts(1), sel);
    const text = (out[0]!.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain("&lt;/operator-messages> inject");
    expect(text).not.toContain("do not </operator-messages> inject");
  });

  test("no operator block when nothing is retained (pre-retention shape preserved)", () => {
    const out = compactionSummaryMessages("summary", ts(1), { kept: [], elided: false });
    const text = (out[0]!.content as { type: string; text: string }[])[0]!.text;
    expect(text).not.toContain("<operator-messages>");
  });
});

describe("compactConversationMessages — carries operator turns into the seed", () => {
  test("folds the pre-boundary operator turns into the summary seed verbatim", async () => {
    const msgs = conversation(40, 800);
    const events: HistoryCompactedEvent[] = [];
    const out = await compactConversationMessages(fakeModel("SUMMARY"), msgs, {
      budget: 5000,
      // A verbatim operator correction from before the boundary (ts(0) is the
      // earliest turn, so it sorts before any boundary the planner picks).
      retainedOperatorTurns: [{ text: "banned phrase: 'circle back'", ts: ts(0) }],
      now: ts(99),
      onEvent: (e) => events.push(e),
    });
    expect(events).toHaveLength(1);
    const seedText = (out[0]!.content as { type: string; text: string }[])[0]!.text;
    expect(seedText).toContain("<operator-messages>");
    expect(seedText).toContain("banned phrase: 'circle back'");
  });

  test("the rendered seed stays bounded even with far more operator text than the cap", async () => {
    const msgs = conversation(40, 800);
    const flood: RetainedOperatorMessage[] = [];
    // 500 large operator turns, all before the boundary — the cap must hold so
    // retention never quietly un-compacts the conversation.
    for (let i = 0; i < 500; i++) flood.push({ text: "Z".repeat(2_000), ts: ts(i) });
    const out = await compactConversationMessages(fakeModel("SUMMARY"), msgs, {
      budget: 5000,
      retainedOperatorTurns: flood,
      now: ts(9999),
      onEvent: () => {},
    });
    const seedText = (out[0]!.content as { type: string; text: string }[])[0]!.text;
    // Whole seed (summary + preamble + tags + retained block) under the cap plus
    // a small fixed wrapper allowance.
    expect(Math.ceil(seedText.length / 4)).toBeLessThanOrEqual(RETAINED_OPERATOR_MAX_TOKENS + 500);
    expect(seedText).toContain("elided"); // the oldest were dropped with a marker
  });
});

describe("reconstructMessages — operator corrections survive REPEATED compaction", () => {
  test("a correction from turn 1 is present after each of several compactions", () => {
    // Reproduces the production failure at n compactions: without retention the
    // correction decays into summary-of-summary and is eventually unrecoverable.
    const correction = "The rule is: address people by first name only, never full name.";
    const events: ConversationEvent[] = [
      { ts: ts(0), type: "user.message", content: [{ type: "text", text: correction }] },
    ];
    for (let round = 1; round <= 6; round++) {
      events.push({
        ts: ts(round * 10),
        type: "user.message",
        content: [{ type: "text", text: `later operator turn ${round}` }],
      });
      events.push({
        ts: ts(round * 10 + 1),
        type: "history.compacted",
        summary: `summary after round ${round}`,
        compactedThroughTs: ts(round * 10), // boundary always past the ts(0) correction
        summarizedMessageCount: round + 1,
      });
      // After EVERY compaction the correction is still present, verbatim.
      const projected = reconstructMessages(events);
      expect(JSON.stringify(projected)).toContain(correction);
    }
    // And it lives in the operator block of the seed, not merely the summary.
    const finalSeed = (reconstructMessages(events)[0]!.content as { text?: string }[])[0]?.text ?? "";
    expect(finalSeed).toContain("<operator-messages>");
    expect(finalSeed).toContain(correction);
  });
});
