// ---------------------------------------------------------------------------
// context-sources — the budget arithmetic behind both ledger surfaces.
//
// The rule these encode is that the recorded rows are NOT four disjoint
// regions: `skills` measures a slice of `system_prompt`. Getting it wrong
// overstates the context window, which is what both surfaces used to do.
//
// The window *total* is not computed here — it ships as `windowTokens` on the
// digest, so there is one answer and no cross-tier copy to keep in sync. What
// remains on this side is layout: which rows render as regions, and in what
// order.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { skillsSlice, sourceDetail, windowSources } from "../lib/context-sources";

const RECORDED = [
  { kind: "system_prompt", tokens: 9600 },
  { kind: "tool_descriptions", count: 32, tokens: 4900 },
  { kind: "skills", count: 7, tokens: 6200, annotation: true },
  { kind: "history", messages: 1, compacted: false, tokens: 1 },
];

describe("windowSources", () => {
  test("drops the annotation row and orders the rest canonically", () => {
    expect(windowSources(RECORDED).map((s) => s.kind)).toEqual([
      "system_prompt",
      "tool_descriptions",
      "history",
    ]);
  });

  // The server stamps `annotation`, so a kind this tier has never heard of
  // renders as a region by default rather than being dropped by a local list.
  test("keeps an unknown unstamped kind, sorted last", () => {
    const kinds = windowSources([...RECORDED, { kind: "memory_seed", tokens: 310 }]).map(
      (s) => s.kind,
    );
    expect(kinds).toEqual(["system_prompt", "tool_descriptions", "history", "memory_seed"]);
  });

  // ...and a future annotation is hidden without this tier knowing its name.
  test("drops any row the server stamped, whatever its kind", () => {
    const kinds = windowSources([
      ...RECORDED,
      { kind: "memory_seed", tokens: 310, annotation: true },
    ]).map((s) => s.kind);
    expect(kinds).toEqual(["system_prompt", "tool_descriptions", "history"]);
  });
});

describe("skillsSlice", () => {
  test("finds the annotation row, and is undefined when absent", () => {
    expect(skillsSlice(RECORDED)?.tokens).toBe(6200);
    expect(skillsSlice(RECORDED.filter((s) => s.kind !== "skills"))).toBeUndefined();
  });
});

describe("sourceDetail", () => {
  test("counts messages, and says message once when there is one", () => {
    expect(sourceDetail({ kind: "history", tokens: 1, messages: 1 })).toBe("1 message");
    expect(sourceDetail({ kind: "history", tokens: 9, messages: 47 })).toBe("47 messages");
  });

  test("joins the count and the compaction marker", () => {
    expect(sourceDetail({ kind: "history", tokens: 9, messages: 47, compacted: true })).toBe(
      "47 messages · compacted",
    );
    expect(sourceDetail({ kind: "tool_descriptions", tokens: 4900, count: 32 })).toBe("32");
  });

  test("is empty when the row carries no discriminators", () => {
    expect(sourceDetail({ kind: "system_prompt", tokens: 9600 })).toBe("");
  });
});
