import { describe, expect, it } from "bun:test";
import type { ToolSchema } from "../../src/engine/types.ts";
import {
  budgetSafetyMarginTokens,
  MIN_BUDGET_SAFETY_MARGIN_TOKENS,
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
      expect(budgetSafetyMarginTokens(ctx)).toBeGreaterThanOrEqual(MIN_BUDGET_SAFETY_MARGIN_TOKENS);
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

  it("keeps a sub-crossover model's budget unchanged", () => {
    // Resolves the margin itself (no override) on a catalog model below the
    // ~164K crossover, so the floor is what binds. This is the inertness
    // claim end to end: every model under the crossover composes exactly the
    // budget it did before.
    const result = resolveMessageBudget({
      model: "nebius:openai/gpt-oss-120b", // 131_072 context
      configMaxInputTokens: 500_000,
      systemPrompt: "",
      tools: [],
      maxOutputTokens: 16_384,
    });
    expect(result.breakdown.modelContextWindow).toBe(131_072);
    expect(result.breakdown.safetyMarginTokens).toBe(MIN_BUDGET_SAFETY_MARGIN_TOKENS);
    expect(result.budget).toBe(131_072 - 16_384 - MIN_BUDGET_SAFETY_MARGIN_TOKENS);
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

  it("keeps estimated system and tool tokens inside a binding configured cap", () => {
    const result = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7",
      configMaxInputTokens: 500_000,
      systemPrompt: "you are a helpful assistant",
      tools: [],
      maxOutputTokens: 16_384,
    });

    expect(result.budget).toBe(500_000 - result.breakdown.systemPromptTokens);
    expect(result.breakdown.boundedByModel).toBe(false);
  });

  it("reduces a binding configured cap by the measured correction", () => {
    const result = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7",
      configMaxInputTokens: 200_000,
      systemPrompt: "you are a helpful assistant",
      tools: [],
      maxOutputTokens: 16_384,
      estimateCorrection: 1.25,
    });

    expect(result.budget).toBe(160_000 - result.breakdown.systemPromptTokens);
    expect(result.breakdown.estimateCorrection).toBe(1.25);
    expect(result.breakdown.boundedByModel).toBe(false);
    expect(
      Math.ceil((result.budget + result.breakdown.systemPromptTokens) * 1.25),
    ).toBeLessThanOrEqual(200_000);
  });

  it("falls back to the configured input cap when the model is not in the catalog", () => {
    const result = resolveMessageBudget({
      model: "anthropic:claude-not-a-real-model",
      configMaxInputTokens: 200_000,
      systemPrompt: "system",
      tools: [],
      maxOutputTokens: 16_384,
    });

    expect(result.budget).toBe(200_000 - result.breakdown.systemPromptTokens);
    expect(result.breakdown.modelContextWindow).toBeNull();
    expect(result.breakdown.boundedByModel).toBe(false);
  });

  it("still corrects the configured cap when the model is absent from the catalog", () => {
    const result = resolveMessageBudget({
      model: "anthropic:claude-not-a-real-model",
      configMaxInputTokens: 200_000,
      systemPrompt: "system",
      tools: [],
      maxOutputTokens: 16_384,
      estimateCorrection: 1.25,
    });

    expect(result.budget).toBe(160_000 - result.breakdown.systemPromptTokens);
    expect(result.breakdown.boundedByModel).toBe(false);
  });

  it("never returns a negative budget when the static prompt exceeds the configured cap", () => {
    const result = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7",
      configMaxInputTokens: 100,
      systemPrompt: "x".repeat(800),
      tools: [],
      maxOutputTokens: 16_384,
      estimateCorrection: 1.25,
    });

    expect(result.budget).toBe(0);
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
      1_000_000 - result.breakdown.toolTokens - 16_384 - budgetSafetyMarginTokens(1_000_000);
    expect(result.budget).toBe(expectedHeadroom);
  });

  it("corrects the whole estimated prompt before subtracting system and tool tokens", () => {
    const tools = [tool("search", "find records".repeat(12))];
    const result = resolveMessageBudget({
      model: "anthropic:claude-opus-4-7",
      configMaxInputTokens: 5_000_000,
      systemPrompt: "system prompt",
      tools,
      maxOutputTokens: 16_384,
      estimateCorrection: 1.25,
    });
    const { systemPromptTokens, toolTokens, safetyMarginTokens } = result.breakdown;
    expect(result.breakdown.boundedByModel).toBe(true);
    expect(result.budget).toBe(
      Math.floor(
        (1_000_000 - 16_384 - safetyMarginTokens) / 1.25 - systemPromptTokens - toolTokens,
      ),
    );
    expect(
      Math.ceil((result.budget + systemPromptTokens + toolTokens) * 1.25) +
        16_384 +
        safetyMarginTokens,
    ).toBeLessThanOrEqual(1_000_000);
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

    expect(default_.budget - tight.budget).toBe(100_000 - budgetSafetyMarginTokens(1_000_000));
  });
});
