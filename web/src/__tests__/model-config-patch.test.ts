import { describe, expect, it } from "bun:test";
import {
  EFFORT_DEFAULT,
  modelConfigPatch,
  THINKING_DEFAULT,
  tuningAppliesTo,
} from "../pages/settings/model-config-patch";

/**
 * The Model tab sends one field per save, so each patch must name exactly that
 * field: a key it adds beyond its own would overwrite a field the operator did
 * not touch. The server side of this contract is exercised with these same
 * patches in test/integration/core-source.test.ts.
 */
describe("modelConfigPatch", () => {
  it("sends a model slot under models, and clears it with null", () => {
    expect(modelConfigPatch("defaultModel", "anthropic:claude-sonnet-5")).toEqual({
      models: { default: "anthropic:claude-sonnet-5" },
    });
    expect(modelConfigPatch("fastModel", "")).toEqual({ models: { fast: null } });
  });

  it("sends a number field as a number, and an empty one as null", () => {
    // `Number("")` is 0, which would pin a zero cap instead of clearing it.
    expect(modelConfigPatch("maxIterations", "12")).toEqual({ maxIterations: 12 });
    expect(modelConfigPatch("maxOutputTokens", "")).toEqual({ maxOutputTokens: null });
    expect(modelConfigPatch("thinkingBudgetTokens", "  ")).toEqual({
      thinkingBudgetTokens: null,
    });
  });

  it("clears the thinking mode and depth with null", () => {
    expect(modelConfigPatch("thinking", THINKING_DEFAULT)).toEqual({ thinking: null });
    expect(modelConfigPatch("thinkingEffort", EFFORT_DEFAULT)).toEqual({ thinkingEffort: null });
    expect(modelConfigPatch("thinkingEffort", "high")).toEqual({ thinkingEffort: "high" });
  });

  it("does not touch depth or budget when the mode changes", () => {
    // Off and adaptive ignore both; leaving them stored means switching back
    // to a mode that reads them restores what the operator set.
    for (const mode of ["off", "adaptive", "enabled", THINKING_DEFAULT] as const) {
      expect(Object.keys(modelConfigPatch("thinking", mode))).toEqual(["thinking"]);
    }
  });
});

describe("tuningAppliesTo", () => {
  it("holds for the default policy and enabled, the modes whose resolver reads depth", () => {
    expect(tuningAppliesTo(THINKING_DEFAULT)).toBe(true);
    expect(tuningAppliesTo("enabled")).toBe(true);
    expect(tuningAppliesTo("off")).toBe(false);
    expect(tuningAppliesTo("adaptive")).toBe(false);
  });
});
