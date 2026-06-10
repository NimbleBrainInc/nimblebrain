import { describe, expect, it, test } from "bun:test";
import { estimateCost } from "../../src/usage/cost.ts";
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

  // ---------------------------------------------------------------------------
  // inputTokens contract: per AI SDK V3 (LanguageModelV3Usage), `inputTokens`
  // is the GRAND TOTAL of all input-side tokens — equal to
  // `noCache + cacheRead + cacheWrite`. The Anthropic provider explicitly
  // computes it that way:
  //   total = inputTokens + cacheCreationTokens + cacheReadTokens
  // (see @ai-sdk/anthropic dist/index.mjs). Engine stores `inputTokens.total`
  // as `inputTokens` in events, so the cost formula must NOT charge those
  // cache tokens at the full input rate AND again at the cache rate.
  // ---------------------------------------------------------------------------

  it("does not double-bill cache read tokens (subset of inputTokens)", () => {
    const model = getModelByString("anthropic:claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model!.cost.cacheRead).toBeGreaterThan(0);
    // 1000 inputTokens total = 200 cache read + 800 non-cached
    const cost = estimateCost("anthropic:claude-sonnet-4-6", {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
    });
    const expected =
      (800 * model!.cost.input + 500 * model!.cost.output + 200 * model!.cost.cacheRead!) /
      1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it("does not double-bill cache write tokens (subset of inputTokens)", () => {
    const model = getModelByString("anthropic:claude-sonnet-4-6");
    expect(model).toBeDefined();
    expect(model!.cost.cacheWrite).toBeGreaterThan(0);
    // 1000 inputTokens total = 300 cache write + 700 non-cached
    const cost = estimateCost("anthropic:claude-sonnet-4-6", {
      inputTokens: 1000,
      outputTokens: 0,
      cacheWriteTokens: 300,
    });
    // Cache writes bill at the 1-hour TTL rate the engine uses: 2x base input.
    const expected =
      (700 * model!.cost.input + 300 * (model!.cost.input * 2)) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it("handles cache read + cache write together (both subsets of inputTokens)", () => {
    const model = getModelByString("anthropic:claude-sonnet-4-6");
    // 1000 total = 200 cache read + 300 cache write + 500 non-cached
    const cost = estimateCost("anthropic:claude-sonnet-4-6", {
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadTokens: 200,
      cacheWriteTokens: 300,
    });
    const expected =
      (500 * model!.cost.input +
        200 * model!.cost.cacheRead! +
        300 * (model!.cost.input * 2)) /
      1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it("clamps non-cached input to zero when cache totals exceed inputTokens", () => {
    // Defensive: if event data is corrupted such that cacheRead+cacheWrite >
    // inputTokens, do not bill negative non-cached input.
    const model = getModelByString("anthropic:claude-sonnet-4-6");
    const cost = estimateCost("anthropic:claude-sonnet-4-6", {
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
    });
    // Non-cached portion = max(100 - 200 - 50, 0) = 0
    const expected =
      (200 * model!.cost.cacheRead! + 50 * (model!.cost.input * 2)) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
  });

  it("matches Anthropic billing on a realistic cache-heavy turn", () => {
    // Real-world numbers from the user's bug report:
    // ~22K non-cached input + 524K cache read + 141K cache write + 10.6K output
    // inputTokens.total = 22K + 524K + 141K = 687K
    const model = getModelByString("anthropic:claude-sonnet-4-6");
    const cost = estimateCost("anthropic:claude-sonnet-4-6", {
      inputTokens: 687_000,
      outputTokens: 10_587,
      cacheReadTokens: 524_000,
      cacheWriteTokens: 141_000,
    });
    const expected =
      (22_000 * model!.cost.input +
        10_587 * model!.cost.output +
        524_000 * model!.cost.cacheRead! +
        141_000 * (model!.cost.input * 2)) /
      1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
    // Sanity: pre-fix code would charge 687K at full input rate AND cache rates,
    // ~3x the correct figure for this shape. Post-fix should match Anthropic.
  });

  it("prices the TTL split: 1h writes at 2x base, the 5-minute remainder at the catalog rate", () => {
    const model = getModelByString("anthropic:claude-sonnet-4-6");
    // 1000 cache writes: 400 written 1h (stable system+tools), 600 written 5m
    // (the rolling history) — the tiered shape the engine now produces.
    const cost = estimateCost("anthropic:claude-sonnet-4-6", {
      inputTokens: 1000,
      outputTokens: 0,
      cacheWriteTokens: 1000,
      cacheWrite1hTokens: 400,
    });
    const expected =
      (400 * (model!.cost.input * 2) + 600 * model!.cost.cacheWrite!) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
    // And it sits strictly between all-1h (2x) and all-5m (1.25x) pricing.
    const allOneHour = (1000 * (model!.cost.input * 2)) / 1_000_000;
    const allFiveMin = (1000 * model!.cost.cacheWrite!) / 1_000_000;
    expect(cost).toBeLessThan(allOneHour);
    expect(cost).toBeGreaterThan(allFiveMin);
  });
});
