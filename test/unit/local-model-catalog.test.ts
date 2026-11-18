import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_LOCAL_CONTEXT_WINDOW,
  getAvailableModels,
  getModelByString,
  getProviderName,
  listProviders,
  localCatalogModels,
  setConfiguredModels,
} from "../../src/model/catalog.ts";
import { resolveMaxOutputTokens } from "../../src/runtime/resolve-max-output-tokens.ts";
import { resolveMessageBudget } from "../../src/runtime/resolve-message-budget.ts";
import { estimateCost, resolveRates } from "../../src/usage/cost.ts";

// The configured models are module state, set at boot; put it back after each test.
afterEach(() => setConfiguredModels("local", "Local", []));

describe("a local server's models in the catalog", () => {
  it("takes the configured window, a quarter of it for output, and no price", () => {
    setConfiguredModels(
      "local",
      "Local",
      localCatalogModels({ models: ["gemma4:e4b"], contextWindow: 16_384 }),
    );

    const model = getModelByString("local:gemma4:e4b");
    expect(model?.limits).toEqual({ context: 16_384, output: 4_096 });
    expect(model?.capabilities.toolCall).toBe(true);
    expect(getProviderName("local")).toBe("Local");
    expect(listProviders()).toContain("local");
  });

  it("defaults the window and caps output at 8,192", () => {
    const [model] = localCatalogModels({ models: ["qwen3:8b"] });
    expect(model?.limits).toEqual({ context: DEFAULT_LOCAL_CONTEXT_WINDOW, output: 8_192 });
  });

  it("is offered in the picker", () => {
    setConfiguredModels("local", "Local", localCatalogModels({ models: ["gemma4:e4b"] }));
    const available = getAvailableModels({ local: {} });
    expect(available.local?.map((m) => m.id)).toEqual(["gemma4:e4b"]);
  });

  it("is priced at zero, not left unpriced", () => {
    setConfiguredModels("local", "Local", localCatalogModels({ models: ["gemma4:e4b"] }));
    expect(resolveRates("local:gemma4:e4b")).not.toBeNull();
    expect(
      estimateCost("local:gemma4:e4b", {
        inputTokens: 20_000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
      }),
    ).toBe(0);
  });

  it("budgets a turn against the window, not the operator's cap", () => {
    setConfiguredModels(
      "local",
      "Local",
      localCatalogModels({ models: ["gemma4:e4b"], contextWindow: 32_768 }),
    );
    const budget = resolveMessageBudget({
      model: "local:gemma4:e4b",
      configMaxInputTokens: 500_000,
      systemPrompt: "",
      tools: [],
      maxOutputTokens: resolveMaxOutputTokens({ model: "local:gemma4:e4b" }),
    });
    expect(budget.breakdown.modelContextWindow).toBe(32_768);
    expect(budget.budget).toBeLessThan(32_768);
  });

  it("leaves no models for a provider set to an empty list", () => {
    setConfiguredModels("local", "Local", localCatalogModels({ models: ["gemma4:e4b"] }));
    setConfiguredModels("local", "Local", []);
    expect(getModelByString("local:gemma4:e4b")).toBeUndefined();
  });
});
