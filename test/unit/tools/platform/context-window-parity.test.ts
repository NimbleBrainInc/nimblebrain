/**
 * The "which rows occupy the context window" rule exists twice — once in the
 * `compose` tool's text summary, once in the web tier — because the browser
 * can't import from `src/`. Two copies of an arithmetic rule that disagree
 * would put a different total on the tool output than on the screen, which is
 * the exact defect the rule was written to fix.
 *
 * This pins them against one fixture. `web/src/lib/context-sources.ts` is
 * safe to import here: its only import is type-only, so no browser value
 * leaks into the root-deps unit graph.
 */

import { describe, expect, test } from "bun:test";
import { windowTokens } from "../../../../web/src/lib/context-sources.ts";
import { contextWindowTokens } from "../../../../src/tools/platform/compose.ts";

const RECORDED = [
  { kind: "system_prompt", tokens: 9600 },
  { kind: "tool_descriptions", count: 32, tokens: 4900 },
  { kind: "skills", count: 7, tokens: 6200 },
  { kind: "history", messages: 1, compacted: false, tokens: 1 },
];

describe("context-window arithmetic — server and web agree", () => {
  test("both exclude the skills annotation from the window", () => {
    expect(contextWindowTokens(RECORDED)).toBe(14501);
    expect(windowTokens(RECORDED)).toBe(14501);
    // The recorded sum counts the skill bodies twice — once inside the system
    // prompt, once in their own row.
    expect(RECORDED.reduce((sum, s) => sum + s.tokens, 0)).toBe(20701);
  });

  // Both are written as "everything except the annotations" rather than as an
  // allowlist of known regions, so a region added later counts on both sides
  // without anyone remembering to update two files. If either flips back to an
  // allowlist, this fails.
  test("a source kind neither tier knows about still counts toward the window", () => {
    const withFutureRegion = [...RECORDED, { kind: "memory_seed", tokens: 310 }];
    expect(contextWindowTokens(withFutureRegion)).toBe(14811);
    expect(windowTokens(withFutureRegion)).toBe(14811);
  });

  test("agree on an empty digest", () => {
    expect(contextWindowTokens([])).toBe(0);
    expect(windowTokens([])).toBe(0);
  });
});
