import { describe, expect, it } from "bun:test";
import {
  EFFORT_DEFAULT,
  effortAppliesTo,
  THINKING_DEFAULT,
  thinkingPatchFor,
} from "../pages/settings/thinking-patch";

/**
 * The Model tab's thinking patch is pure, so it is testable without mounting
 * the panel — and it needs to be. The depth control shipped twice in a state
 * where saving this screen wiped a depth set through the config file or the
 * admin tool, because nothing here asserted the payload.
 */
describe("thinkingPatchFor", () => {
  it("carries a chosen depth on the default path", () => {
    // The resolver's default path reads configEffort, so "default policy but
    // think harder" has to be expressible without pinning a mode — pinning
    // one is not equivalent, it skips the reasoning-capability check.
    expect(thinkingPatchFor(THINKING_DEFAULT, "high", null)).toEqual({
      clearThinking: true,
      thinkingEffort: "high",
      clearThinkingBudget: true,
    });
  });

  it("clears the depth on the default path only when the operator chose no tier", () => {
    expect(thinkingPatchFor(THINKING_DEFAULT, EFFORT_DEFAULT, null)).toEqual({
      clearThinking: true,
      clearThinkingEffort: true,
      clearThinkingBudget: true,
    });
  });

  it("carries the depth alongside an explicit budget", () => {
    // Independent controls: the budget meters providers that count tokens,
    // the tier is what every other provider uses.
    expect(thinkingPatchFor("enabled", "max", 8192)).toEqual({
      thinking: "enabled",
      thinkingEffort: "max",
      thinkingBudgetTokens: 8192,
    });
  });

  it("clears the budget when the field is empty rather than inventing one", () => {
    expect(thinkingPatchFor("enabled", "low", null)).toEqual({
      thinking: "enabled",
      thinkingEffort: "low",
      clearThinkingBudget: true,
    });
  });

  it("drops depth and budget for off and adaptive", () => {
    // Both state no depth by definition, and the resolver returns before
    // reading either.
    for (const mode of ["off", "adaptive"] as const) {
      expect(thinkingPatchFor(mode, "max", 8192)).toEqual({
        thinking: mode,
        clearThinkingEffort: true,
        clearThinkingBudget: true,
      });
    }
  });

  it("never leaves a field neither set nor cleared", () => {
    // A field that is silently omitted keeps whatever is on disk from an
    // earlier save, which is indistinguishable from the operator having
    // chosen it.
    const cases = [
      thinkingPatchFor(THINKING_DEFAULT, EFFORT_DEFAULT, null),
      thinkingPatchFor(THINKING_DEFAULT, "high", 4096),
      thinkingPatchFor("enabled", EFFORT_DEFAULT, null),
      thinkingPatchFor("enabled", "max", 8192),
      thinkingPatchFor("off", "high", 4096),
      thinkingPatchFor("adaptive", "low", null),
    ];
    for (const patch of cases) {
      expect("thinkingEffort" in patch || patch.clearThinkingEffort === true).toBe(true);
      expect("thinkingBudgetTokens" in patch || patch.clearThinkingBudget === true).toBe(true);
    }
  });

  it("carries the depth in exactly the modes that show the control", () => {
    // The render gate and the patch are both `effortAppliesTo`. When they
    // were written separately they drifted, and the drift silently wiped a
    // depth set elsewhere. This asserts they cannot disagree again.
    for (const mode of [THINKING_DEFAULT, "enabled", "off", "adaptive"] as const) {
      const carries = "thinkingEffort" in thinkingPatchFor(mode, "high", null);
      expect(carries).toBe(effortAppliesTo(mode));
    }
  });
});
