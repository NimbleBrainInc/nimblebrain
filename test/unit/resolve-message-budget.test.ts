import { describe, expect, it } from "bun:test";
import type { ToolSchema } from "../../src/engine/types.ts";
import {
  MIN_BUDGET_SAFETY_MARGIN_TOKENS,
  budgetSafetyMarginTokens,
  resolveMessageBudget,
} from "../../src/runtime/resolve-message-budget.ts";

function tool(name: string, description: string): ToolSchema {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { q: { type: "string" } },
    },
  };
}

describe("budgetSafetyMarginTokens", () => {
  it("holds the floor for windows the ratio resolves below it", () => {
    // 8192 / 0.05 = 163_840 is the crossover; at or under it the floor binds,
    // so every small-context model keeps exactly its previous margin.
    expect(budgetSafetyMarginTokens(0)).toBe(MIN_BUDGET_SAFETY_MARGIN_TOKENS);
    expect(budgetSafetyMarginTokens(64_000)).toBe(MIN_BUDGET_SAFETY_MARGIN_TOKENS);
    expect(budgetSafetyMarginTokens(163_840)).toBe(MIN_BUDGET_SAFETY_MARGIN_TOKENS);
  });

  it("scales with the window above the crossover", () => {
    expect(budgetSafetyMarginTokens(200_000)).toBe(10_000);
    expect(budgetSafetyMarginTokens(262_144)).toBe(13_108);
    expect(budgetSafetyMarginTokens(1_000_000)).toBe(50_000);
  });

  it("never resolves below the floor for any window", () => {
    for (const ctx of [1, 1_000, 32_768, 100_000, 163_839]) {
      expect(budgetSafetyMarginTokens(ctx)).toBeGreaterThanOrEqual(
        MIN_BUDGET_SAFETY_MARGIN_TOKENS,
      );
    }
  });
});

describe("resolveMessageBudget — large-window drift", () => {
  it("leaves headroom for the drift that overflowed a 262K model by one token", () => {
    // Observed in production: a turn on a 262,144-context model whose prompt
    // the provider counted at 245,761 input tokens against 16,384 reserved
    // output — one token over. Our pre-flight estimate had been 8,193 lower,
    // which is the flat 8,192 margin plus one. The margin has to exceed the
    // drift, not merely exist.
    const OBSERVED_DRIFT = 8_193;
    const result = resolveMessageBudget({
      model: "nebius:moonshotai/Kimi-K2.6",
      configMaxInputTokens: 500_000,
      systemPrompt: "",
      tools: [],
      maxOutputTokens: 16_384,
    });

    expect(result.breakdown.modelContextWindow).toBe(262_144);
    expect(result.breakdown.safetyMarginTokens).toBeGreaterThan(OBSERVED_DRIFT);
    // The whole composition still fits with the drift applied on top.
    expect(result.budget + 16_384 + OBSERVED_DRIFT).toBeLessThanOrEqual(262_144);
  });

  it("keeps a small-context model's budget unchanged", () => {
    // The floor binds under the crossover, so this change is inert for every
    // model below ~164K — including the 64K lower bound the Nebius catalog
    // sync reasons against.
    const result = resolveMessageBudget({
      model: "nebius:moonshotai/Kimi-K2.6",
      configMaxInputTokens: 500_000,
      systemPrompt: "",
      tools: [],
      maxOutputTokens: 16_384,
      safetyMarginTokens: MIN_BUDGET_SAFETY_MARGIN_TOKENS,
    });
    expect(result.budget).toBe(262_144 - 16_384 - MIN_BUDGET_SAFETY_MARGIN_TOKENS);
  });
});

describe("resolveMessageBudget", () => {
  it("uses model context window minus overhead when headroom is the binding constraint", () => {
    const systemPrompt = "you are a helpful assistant";
    const result = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7", // 1M context
      configMaxInputTokens: 5_000_000, // far above headroom
      systemPrompt,
      tools: [],
      maxOutputTokens: 16_384,
    });

    expect(result.breakdown.modelContextWindow).toBe(1_000_000);
    expect(result.breakdown.boundedByModel).toBe(true);
    // Deterministic: budget = 1M − ceil(sysLen/4) − 0 − maxOutput − safety.
    // Asserting the exact number so any silent change to the formula or the
    // safety-margin constant fails this test rather than slipping through.
    const expected =
      1_000_000 -
      Math.ceil(systemPrompt.length / 4) -
      0 -
      16_384 -
      budgetSafetyMarginTokens(1_000_000);
    expect(result.budget).toBe(expected);
  });

  it("uses configMaxInputTokens when it's lower than the model headroom", () => {
    const result = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7",
      configMaxInputTokens: 500_000,
      systemPrompt: "you are a helpful assistant",
      tools: [],
      maxOutputTokens: 16_384,
    });

    expect(result.budget).toBe(500_000);
    expect(result.breakdown.boundedByModel).toBe(false);
  });

  it("falls back to configMaxInputTokens when the model is not in the catalog", () => {
    const result = resolveMessageBudget({
      model: "anthropic:claude-not-a-real-model",
      configMaxInputTokens: 200_000,
      systemPrompt: "system",
      tools: [],
      maxOutputTokens: 16_384,
    });

    expect(result.budget).toBe(200_000);
    expect(result.breakdown.modelContextWindow).toBeNull();
    expect(result.breakdown.boundedByModel).toBe(false);
  });

  it("subtracts tool description tokens from headroom", () => {
    const tools = Array.from({ length: 20 }, (_, i) =>
      tool(`tool_${i}`, "a description that uses a few tokens".repeat(4)),
    );
    const result = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7",
      configMaxInputTokens: 5_000_000,
      systemPrompt: "",
      tools,
      maxOutputTokens: 16_384,
    });

    expect(result.breakdown.toolTokens).toBeGreaterThan(0);
    // headroom = 1M − 0 − toolTokens − 16384 − margin(1M)
    const expectedHeadroom =
      1_000_000 -
      result.breakdown.toolTokens -
      16_384 -
      budgetSafetyMarginTokens(1_000_000);
    expect(result.budget).toBe(expectedHeadroom);
  });

  it("subtracts maxOutputTokens from headroom", () => {
    const a = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7",
      configMaxInputTokens: 5_000_000,
      systemPrompt: "",
      tools: [],
      maxOutputTokens: 1_000,
    });
    const b = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7",
      configMaxInputTokens: 5_000_000,
      systemPrompt: "",
      tools: [],
      maxOutputTokens: 100_000,
    });

    expect(a.budget - b.budget).toBe(100_000 - 1_000);
  });

  it("returns budget=0 when static overhead alone exceeds the model context window", () => {
    const result = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7",
      configMaxInputTokens: 5_000_000,
      systemPrompt: "x".repeat(4_000_000), // ~1M tokens — already over the window
      tools: [],
      maxOutputTokens: 16_384,
    });

    expect(result.budget).toBe(0);
    expect(result.breakdown.boundedByModel).toBe(true);
  });

  it("honors a custom safety margin", () => {
    const tight = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7",
      configMaxInputTokens: 5_000_000,
      systemPrompt: "",
      tools: [],
      maxOutputTokens: 16_384,
      safetyMarginTokens: 100_000,
    });
    const default_ = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7",
      configMaxInputTokens: 5_000_000,
      systemPrompt: "",
      tools: [],
      maxOutputTokens: 16_384,
    });

    expect(default_.budget - tight.budget).toBe(
      100_000 - budgetSafetyMarginTokens(1_000_000),
    );
  });
});
