import { describe, expect, it, test } from "bun:test";
import { estimateCost } from "../../src/engine/cost.ts";
import { getModelByString } from "../../src/model/catalog.ts";

describe("estimateCost", () => {
  const modelCases = [
    { label: "anthropic", modelString: "anthropic:claude-sonnet-4-6" },
    { label: "openai", modelString: "openai:gpt-4o" },
    { label: "gemini", modelString: "google:gemini-2.5-flash" },
  ] as const;

  test.each(modelCases)(
    "calculates cost correctly for $label model",
    ({ modelString }) => {
      const model = getModelByString(modelString);
      expect(model).toBeDefined();
      expect(model!.cost.input).toBeGreaterThan(0);
      expect(model!.cost.output).toBeGreaterThan(0);

      const cost = estimateCost(modelString, {
        inputTokens: 1000,
        outputTokens: 500,
      });
      const expected = (1000 * model!.cost.input + 500 * model!.cost.output) / 1_000_000;
      expect(cost).toBeCloseTo(expected, 8);
      expect(cost).toBeGreaterThan(0);
    },
  );

  it("bare model string defaults to anthropic provider", () => {
    const withPrefix = estimateCost("anthropic:claude-sonnet-4-6", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    const withoutPrefix = estimateCost("claude-sonnet-4-6", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(withPrefix).toBe(withoutPrefix);
    expect(withPrefix).toBeGreaterThan(0);
  });

  it("includes cache read tokens in cost calculation", () => {
    const model = getModelByString("anthropic:claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model!.cost.cacheRead).toBeGreaterThan(0);
    const cost = estimateCost("anthropic:claude-sonnet-4-6", {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
    });
    const expected = (1000 * model!.cost.input + 500 * model!.cost.output + 200 * model!.cost.cacheRead!) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it("returns 0 for unknown model", () => {
    const cost = estimateCost("unknown-provider:unknown-model", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(cost).toBe(0);
  });

  it("returns 0 when token counts are zero", () => {
    const cost = estimateCost("anthropic:claude-sonnet-4-6", {
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBe(0);
  });
});
