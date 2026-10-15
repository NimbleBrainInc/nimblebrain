import { describe, expect, it, test } from "bun:test";
import { getModelByString } from "../../src/model/catalog.ts";
import { costBreakdown, estimateCost, resolveRates } from "../../src/usage/cost.ts";

describe("estimateCost", () => {
  const modelCases = [
    { label: "anthropic", modelString: "anthropic:claude-sonnet-4-6" },
    { label: "openai", modelString: "openai:gpt-4o" },
    { label: "gemini", modelString: "google:gemini-2.5-flash" },
  ] as const;

  for (const { label, modelString } of modelCases)
    test(`calculates cost correctly for ${label} model`, () => {
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
    });

  it("a model string with no provider is unpriced", () => {
    expect(
      estimateCost("anthropic:claude-sonnet-4-6", { inputTokens: 1000, outputTokens: 500 }),
    ).toBeGreaterThan(0);
    expect(estimateCost("claude-sonnet-4-6", { inputTokens: 1000, outputTokens: 500 })).toBe(0);
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
  // inputTokens contract: per AI SDK V3 (LanguageModelV4Usage), `inputTokens`
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
    const expected = (700 * model!.cost.input + 300 * (model!.cost.input * 2)) / 1_000_000;
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
      (500 * model!.cost.input + 200 * model!.cost.cacheRead! + 300 * (model!.cost.input * 2)) /
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
    const expected = (200 * model!.cost.cacheRead! + 50 * (model!.cost.input * 2)) / 1_000_000;
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
    const expected = (400 * (model!.cost.input * 2) + 600 * model!.cost.cacheWrite!) / 1_000_000;
    expect(cost).toBeCloseTo(expected, 8);
    // And it sits strictly between all-1h (2x) and all-5m (1.25x) pricing.
    const allOneHour = (1000 * (model!.cost.input * 2)) / 1_000_000;
    const allFiveMin = (1000 * model!.cost.cacheWrite!) / 1_000_000;
    expect(cost).toBeLessThan(allOneHour);
    expect(cost).toBeGreaterThan(allFiveMin);
  });
});

describe("prompt-length rate cards", () => {
  const HAIKU = "anthropic:claude-haiku-5-5";

  it("resolves Haiku 5.5 with its two rate cards", () => {
    const model = getModelByString(HAIKU);
    expect(model?.limits).toEqual({ context: 1_000_000, output: 128_000 });
    expect(model?.capabilities.reasoning).toBe(true);
    expect(resolveRates(HAIKU)).toEqual({
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite5m: 0.125,
      cacheWrite1h: 0.2,
      tiers: [
        {
          aboveInputTokens: 100_000,
          input: 0.5,
          output: 2.5,
          cacheRead: 0.05,
          cacheWrite5m: 0.625,
          cacheWrite1h: 1,
        },
      ],
    });
  });

  it("bills a prompt at the threshold on the base card", () => {
    const cost = costBreakdown(HAIKU, {
      inputTokens: 100_000,
      outputTokens: 1_000,
      cacheReadTokens: 60_000,
      cacheWriteTokens: 30_000,
      cacheWrite1hTokens: 10_000,
    });
    expect(cost.input).toBeCloseTo((10_000 * 0.1) / 1e6, 10);
    expect(cost.output).toBeCloseTo((1_000 * 0.5) / 1e6, 10);
    expect(cost.cacheRead).toBeCloseTo((60_000 * 0.01) / 1e6, 10);
    expect(cost.cacheWrite).toBeCloseTo((10_000 * 0.2 + 20_000 * 0.125) / 1e6, 10);
  });

  it("bills every bucket of a longer prompt on the long-prompt card", () => {
    const cost = costBreakdown(HAIKU, {
      inputTokens: 100_001,
      outputTokens: 1_000,
      cacheReadTokens: 60_000,
      cacheWriteTokens: 30_000,
      cacheWrite1hTokens: 10_000,
    });
    expect(cost.input).toBeCloseTo((10_001 * 0.5) / 1e6, 10);
    expect(cost.output).toBeCloseTo((1_000 * 2.5) / 1e6, 10);
    expect(cost.cacheRead).toBeCloseTo((60_000 * 0.05) / 1e6, 10);
    expect(cost.cacheWrite).toBeCloseTo((10_000 * 1 + 20_000 * 0.625) / 1e6, 10);
  });

  it("picks the card from rates stored on a ledger line", () => {
    const stored = { ...resolveRates(HAIKU)!, tiers: [] };
    // A line written before tiers existed carries none, and replays on the base card.
    expect(
      costBreakdown(HAIKU, { inputTokens: 200_000, outputTokens: 0 }, stored).total,
    ).toBeCloseTo((200_000 * 0.1) / 1e6, 10);
  });

  it("applies the highest tier the prompt exceeds", () => {
    const rates = {
      input: 1,
      output: 1,
      cacheRead: 1,
      cacheWrite5m: 1,
      cacheWrite1h: 1,
      tiers: [
        {
          aboveInputTokens: 10,
          input: 2,
          output: 2,
          cacheRead: 2,
          cacheWrite5m: 2,
          cacheWrite1h: 2,
        },
        {
          aboveInputTokens: 20,
          input: 3,
          output: 3,
          cacheRead: 3,
          cacheWrite5m: 3,
          cacheWrite1h: 3,
        },
      ],
    };
    const at = (inputTokens: number) =>
      costBreakdown("x:y", { inputTokens, outputTokens: 0 }, rates).total * 1e6;
    expect(at(10)).toBeCloseTo(10, 8);
    expect(at(15)).toBeCloseTo(30, 8);
    expect(at(25)).toBeCloseTo(75, 8);
  });

  it("carries xAI's long-context card", () => {
    const rates = resolveRates("xai:grok-4.3");
    expect(rates?.tiers?.[0]).toMatchObject({ aboveInputTokens: 200_000, input: 2.5, output: 5 });
  });

  it("leaves a model with one rate card unchanged", () => {
    const rates = resolveRates("anthropic:claude-sonnet-5-5");
    expect(rates?.tiers).toBeUndefined();
    expect(
      estimateCost("anthropic:claude-sonnet-5-5", { inputTokens: 500_000, outputTokens: 0 }),
    ).toBeCloseTo((500_000 * 2) / 1e6, 10);
  });
});
