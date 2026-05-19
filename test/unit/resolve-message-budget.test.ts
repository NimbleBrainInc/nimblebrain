import { describe, expect, it } from "bun:test";
import type { ToolSchema } from "../../src/engine/types.ts";
import {
  DEFAULT_BUDGET_SAFETY_MARGIN_TOKENS,
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
      DEFAULT_BUDGET_SAFETY_MARGIN_TOKENS;
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
    // headroom = 1M − 0 − toolTokens − 16384 − 8192
    const expectedHeadroom =
      1_000_000 -
      result.breakdown.toolTokens -
      16_384 -
      DEFAULT_BUDGET_SAFETY_MARGIN_TOKENS;
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
      100_000 - DEFAULT_BUDGET_SAFETY_MARGIN_TOKENS,
    );
  });
});
