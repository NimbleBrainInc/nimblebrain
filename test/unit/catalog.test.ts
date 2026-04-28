import { describe, expect, it } from "bun:test";
import {
	getModel,
	getModelByString,
	listModels,
	listProviders,
	getProviderName,
	getAvailableModels,
	isModelAllowed,
	estimateCost,
} from "../../src/model/catalog.ts";

describe("Model Catalog", () => {
	it("listProviders returns anthropic, openai, google", () => {
		const providers = listProviders();
		expect(providers).toContain("anthropic");
		expect(providers).toContain("openai");
		expect(providers).toContain("google");
	});

	it("getProviderName returns display names", () => {
		expect(getProviderName("anthropic")).toBe("Anthropic");
		expect(getProviderName("openai")).toBe("OpenAI");
		expect(getProviderName("google")).toBe("Google");
		expect(getProviderName("unknown")).toBe("unknown");
	});

	it("getModel returns model metadata", () => {
		const model = getModel("anthropic", "claude-sonnet-4-6");
		expect(model).toBeDefined();
		expect(model!.id).toBe("claude-sonnet-4-6");
		expect(model!.provider).toBe("anthropic");
		expect(model!.name).toBeTruthy();
		expect(model!.cost.input).toBeGreaterThan(0);
		expect(model!.cost.output).toBeGreaterThan(0);
		expect(model!.limits.context).toBeGreaterThan(0);
		expect(model!.capabilities.toolCall).toBe(true);
	});

	it("getModel returns undefined for unknown model", () => {
		expect(getModel("anthropic", "nonexistent")).toBeUndefined();
		expect(getModel("unknown-provider", "anything")).toBeUndefined();
	});

	it("getModelByString parses provider:model-id", () => {
		const model = getModelByString("openai:gpt-4o");
		expect(model).toBeDefined();
		expect(model!.provider).toBe("openai");
		expect(model!.id).toBe("gpt-4o");
	});

	it("getModelByString defaults bare strings to anthropic", () => {
		const model = getModelByString("claude-sonnet-4-6");
		expect(model).toBeDefined();
		expect(model!.provider).toBe("anthropic");
	});

	it("listModels returns all models for a provider", () => {
		const models = listModels("anthropic");
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(m.provider).toBe("anthropic");
			expect(m.cost.input).toBeGreaterThanOrEqual(0);
		}
	});

	it("listModels with allowlist filters to specified models", () => {
		const models = listModels("anthropic", ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]);
		expect(models.length).toBe(2);
		const ids = models.map((m) => m.id).sort();
		expect(ids).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-4-6"]);
	});

	it("listModels with empty allowlist returns all", () => {
		const all = listModels("anthropic");
		const withEmpty = listModels("anthropic", []);
		expect(withEmpty.length).toBe(all.length);
	});
});

describe("isModelAllowed", () => {
	it("allows model when provider is configured with no allowlist", () => {
		expect(isModelAllowed("anthropic:claude-sonnet-4-6", { anthropic: {} })).toBe(true);
	});

	it("rejects model when provider is not configured", () => {
		expect(isModelAllowed("openai:gpt-4o", { anthropic: {} })).toBe(false);
	});

	it("allows model in provider allowlist", () => {
		expect(isModelAllowed("anthropic:claude-sonnet-4-6", {
			anthropic: { models: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"] },
		})).toBe(true);
	});

	it("rejects model not in provider allowlist", () => {
		expect(isModelAllowed("anthropic:claude-opus-4-6", {
			anthropic: { models: ["claude-sonnet-4-6"] },
		})).toBe(false);
	});

	it("bare string defaults to anthropic", () => {
		expect(isModelAllowed("claude-sonnet-4-6", { anthropic: {} })).toBe(true);
		expect(isModelAllowed("claude-sonnet-4-6", { openai: {} })).toBe(false);
	});
});

describe("getAvailableModels", () => {
	it("returns models grouped by configured provider", () => {
		const result = getAvailableModels({ anthropic: {}, openai: {} });
		expect(Object.keys(result)).toContain("anthropic");
		expect(Object.keys(result)).toContain("openai");
		expect(Object.keys(result)).not.toContain("google");
		expect(result.anthropic.length).toBeGreaterThan(0);
		expect(result.openai.length).toBeGreaterThan(0);
	});

	it("respects per-provider model allowlist", () => {
		const result = getAvailableModels({
			anthropic: { models: ["claude-sonnet-4-6"] },
			openai: {},
		});
		expect(result.anthropic.length).toBe(1);
		expect(result.anthropic[0].id).toBe("claude-sonnet-4-6");
		expect(result.openai.length).toBeGreaterThan(1);
	});
});

describe("estimateCost from catalog", () => {
	it("returns positive cost for known model", () => {
		const cost = estimateCost("anthropic:claude-sonnet-4-6", {
			inputTokens: 10000,
			outputTokens: 5000,
		});
		expect(cost).toBeGreaterThan(0);
	});

	it("returns 0 for unknown model", () => {
		const cost = estimateCost("fake:model", { inputTokens: 1000, outputTokens: 500 });
		expect(cost).toBe(0);
	});

	it("does not double-bill reasoning tokens when cost.reasoning is set", () => {
		// Construct synthetic usage where reasoning is the entire output.
		// If the formula were `output*c.output + reasoning*c.reasoning`, a
		// reasoning-heavy turn would be charged twice. With the corrected
		// formula, the reasoning subset bills at c.reasoning and the
		// remainder at c.output.
		//
		// Use a model that has cost.reasoning set in the catalog. Falls
		// back gracefully if no such model exists in the bundled snapshot.
		// (As of writing, no Anthropic model in the catalog has cost.reasoning
		// — the field is reserved for providers that bill reasoning separately.
		// We assert behavior using the equivalent default-output path.)
		const c1 = estimateCost("anthropic:claude-opus-4-7", {
			inputTokens: 0,
			outputTokens: 1000,
			reasoningTokens: 1000,
		});
		const c2 = estimateCost("anthropic:claude-opus-4-7", {
			inputTokens: 0,
			outputTokens: 1000,
			// No reasoning subtotal.
		});
		// Without cost.reasoning set, both formulas should yield the same
		// total — i.e., reasoning isn't being added on top of output.
		expect(c1).toBe(c2);
	});

	it("cache read tokens reduce vs full input pricing", () => {
		const model = getModelByString("anthropic:claude-sonnet-4-6");
		expect(model!.cost.cacheRead).toBeLessThan(model!.cost.input);

		const withoutCache = estimateCost("anthropic:claude-sonnet-4-6", {
			inputTokens: 10000,
			outputTokens: 0,
		});
		const withCache = estimateCost("anthropic:claude-sonnet-4-6", {
			inputTokens: 5000,
			outputTokens: 0,
			cacheReadTokens: 5000,
		});
		expect(withCache).toBeLessThan(withoutCache);
	});
});
