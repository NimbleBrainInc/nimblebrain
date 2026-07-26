// ---------------------------------------------------------------------------
// context-sources — the budget arithmetic behind both ledger surfaces.
//
// The rule these encode is that the recorded rows are NOT four disjoint
// regions: `skills` measures a slice of `system_prompt`. Getting it wrong
// overstates the context window, which is what both surfaces used to do.
//
// The server tier carries its own copy (it can't share code with the browser);
// `test/unit/tools/platform/context-window-parity.test.ts` pins the two
// together. This file covers the web side's own behavior.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { skillsSlice, sourceDetail, windowSources, windowTokens } from "../lib/context-sources";

const RECORDED = [
  { kind: "system_prompt", tokens: 9600 },
  { kind: "tool_descriptions", count: 32, tokens: 4900 },
  { kind: "skills", count: 7, tokens: 6200 },
  { kind: "history", messages: 1, compacted: false, tokens: 1 },
];

describe("windowTokens", () => {
  test("excludes the skills annotation from the window", () => {
    expect(windowTokens(RECORDED)).toBe(14501);
    // What the recorded `totalTokens` would be: the skill bodies twice.
    expect(RECORDED.reduce((sum, s) => sum + s.tokens, 0)).toBe(20701);
  });

  // Stated as "everything except the annotations", so a region added later
  // counts without anyone editing this file. An allowlist would drop it and
  // quietly understate the window again.
  test("counts a source kind it has never heard of", () => {
    expect(windowTokens([...RECORDED, { kind: "memory_seed", tokens: 310 }])).toBe(14811);
  });

  test("is zero for an empty digest", () => {
    expect(windowTokens([])).toBe(0);
  });
});

describe("windowSources", () => {
  test("drops the annotation row and orders the rest canonically", () => {
    expect(windowSources(RECORDED).map((s) => s.kind)).toEqual([
      "system_prompt",
      "tool_descriptions",
      "history",
    ]);
  });

  test("keeps an unknown kind, sorted last", () => {
    const kinds = windowSources([...RECORDED, { kind: "memory_seed", tokens: 310 }]).map(
      (s) => s.kind,
    );
    expect(kinds).toEqual(["system_prompt", "tool_descriptions", "history", "memory_seed"]);
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
