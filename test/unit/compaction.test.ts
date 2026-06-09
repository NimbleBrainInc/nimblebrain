import { describe, expect, test } from "bun:test";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { reconstructMessages } from "../../src/conversation/event-reconstructor.ts";
import {
  compactConversationMessages,
  compactionSummaryMessages,
  estimateMessagesTokens,
  planCompaction,
  runCompaction,
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
    expect(text).toContain("<\\/conversation-summary> injection");
  });
});

// --- summarizeMessages / runCompaction -------------------------------------

describe("summarizeMessages + runCompaction", () => {
  test("summarizeMessages returns the model's trimmed text", async () => {
    const out = await summarizeMessages(fakeModel("  a dense summary  "), conversation(2, 40));
    expect(out).toBe("a dense summary");
  });

  test("summarizeMessages throws on an empty model response", async () => {
    await expect(summarizeMessages(fakeModel(""), conversation(2, 40))).rejects.toThrow();
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
    // the two pre-boundary turns are gone; the kept turn survives verbatim
    const allText = JSON.stringify(msgs);
    expect(allText).not.toContain("old turn 1");
    expect(allText).not.toContain("old turn 2");
    expect(allText).toContain("kept turn");
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
    expect(joined).toContain("second summary subsumes first");
    expect(joined).not.toContain("first summary");
    expect(joined).not.toContain("ancient");
    expect(joined).not.toContain("middle");
    expect(joined).toContain("recent");
  });

  test("no compaction event → unchanged reconstruction", () => {
    const events: ConversationEvent[] = [
      { ts: ts(0), type: "user.message", content: [{ type: "text", text: "hi" }] },
    ];
    const msgs = reconstructMessages(events);
    expect((msgs[0]!.content as { text?: string }[])[0]?.text).toBe("hi");
  });
});
