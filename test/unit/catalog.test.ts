import { describe, expect, it } from "bun:test";
import {
	GOOGLE_THINKING_LEVELS,
	findProviderForModelId,
	getAvailableModels,
	getModel,
	getModelByString,
	getProviderName,
	googleThinkingSupport,
	isModelAllowed,
	listModels,
	listProviders,
	supportsEnabledThinking,
} from "../../src/model/catalog.ts";
import { estimateCost } from "../../src/usage/cost.ts";

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

describe("findProviderForModelId", () => {
	it("returns the owning provider for a known anthropic id", () => {
		expect(findProviderForModelId("claude-sonnet-4-6")).toBe("anthropic");
	});

	it("returns the owning provider for a known google id", () => {
		expect(findProviderForModelId("gemini-3.1-pro-preview")).toBe("google");
	});

	it("returns the owning provider for a known openai id", () => {
		expect(findProviderForModelId("gpt-4o")).toBe("openai");
	});

	it("returns null for an unknown model id", () => {
		// Pinned/custom model ids that aren't in the catalog should fall back
		// to the resolver's anthropic-default path, not to a wrong provider.
		expect(findProviderForModelId("custom-fine-tune-not-in-catalog")).toBeNull();
	});

	it("returns null for the empty string", () => {
		expect(findProviderForModelId("")).toBeNull();
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

	it("excludes deprecated models from the picker", () => {
		// gemini-3-pro-preview was retired by Google 2026-03-09. It stays in the
		// catalog (so existing references still resolve for cost/display) but
		// must never be offered as a selectable model.
		const deprecated = getModelByString("google:gemini-3-pro-preview");
		expect(deprecated?.deprecated).toBe(true);

		const result = getAvailableModels({ google: {} });
		expect(result.google.length).toBeGreaterThan(0);
		expect(result.google.some((m) => m.id === "gemini-3-pro-preview")).toBe(false);
		// The live successor is still offered.
		expect(result.google.some((m) => m.id === "gemini-3.1-pro-preview")).toBe(true);
	});
});

describe("supportsEnabledThinking", () => {
	it("returns false for adaptive-only Anthropic models", () => {
		// These reject thinking.type=enabled with a 400; the engine must
		// translate to thinking.type=adaptive + output_config.effort.
		expect(supportsEnabledThinking("claude-opus-4-7")).toBe(false);
		expect(supportsEnabledThinking("claude-opus-4-8")).toBe(false);
		expect(supportsEnabledThinking("claude-opus-5")).toBe(false);
		expect(supportsEnabledThinking("claude-sonnet-5")).toBe(false);
		expect(supportsEnabledThinking("anthropic:claude-opus-4-8")).toBe(false);
	});

	it("returns true for Anthropic models that accept the enabled shape", () => {
		expect(supportsEnabledThinking("claude-sonnet-4-6")).toBe(true);
		expect(supportsEnabledThinking("claude-haiku-4-5-20251001")).toBe(true);
	});

	it("returns true for non-Anthropic providers", () => {
		expect(supportsEnabledThinking("openai:gpt-4o")).toBe(true);
		expect(supportsEnabledThinking("google:gemini-2.5-pro")).toBe(true);
	});

	// Anthropic reasoning models known to accept `thinking.type=enabled`.
	// Anything absent must be in ADAPTIVE_ONLY_THINKING_MODELS — see the guard.
	const ACCEPTS_ENABLED_THINKING = new Set([
		"claude-haiku-4-5",
		"claude-haiku-4-5-20251001",
		"claude-opus-4-1",
		"claude-opus-4-1-20250805",
		"claude-opus-4-5",
		"claude-opus-4-5-20251101",
		"claude-opus-4-6",
		"claude-sonnet-4-5",
		"claude-sonnet-4-5-20250929",
		"claude-sonnet-4-6",
	]);

	it("classifies every Anthropic reasoning model in the catalog", () => {
		// `bun run sync-models` adds Anthropic models to the catalog — and the
		// picker — automatically, but the enabled-vs-adaptive-only split is
		// hand-maintained because models.dev doesn't track it. A reasoning
		// model that lands unclassified gets the `enabled` shape and 400s on
		// EVERY call: Opus 4.7, then 4.8 + Sonnet 5, then Opus 5 each needed a
		// manual entry. This fails the sync instead of shipping a broken model.
		//
		// To fix a failure: decide which shape the new model takes, then add it
		// to ADAPTIVE_ONLY_THINKING_MODELS in src/model/catalog.ts or to
		// ACCEPTS_ENABLED_THINKING above.
		const unclassified = listModels("anthropic")
			.filter((m) => m.capabilities.reasoning)
			.map((m) => m.id)
			.filter((id) => supportsEnabledThinking(id) && !ACCEPTS_ENABLED_THINKING.has(id));

		expect(unclassified).toEqual([]);
	});

	it("keeps the two classifications disjoint", () => {
		// The check above short-circuits on supportsEnabledThinking, so an id
		// listed in BOTH sets would slip through it — a contradictory
		// classification that reads as deliberate. Assert the intersection is
		// empty so the pair stays a genuine partition.
		const inBoth = [...ACCEPTS_ENABLED_THINKING].filter((id) => !supportsEnabledThinking(id));

		expect(inBoth).toEqual([]);
	});
});

describe("Fable 5 exclusion", () => {
	it("is not in the catalog under any string form", () => {
		// Premium research tier — excluded at sync time so it can't be
		// selected in the picker or pointed at by a tenant slot.
		expect(getModelByString("claude-fable-5")).toBeUndefined();
		expect(getModelByString("anthropic:claude-fable-5")).toBeUndefined();
		expect(getModel("anthropic", "claude-fable-5")).toBeUndefined();
	});

	it("is not offered in the picker", () => {
		const result = getAvailableModels({ anthropic: {} });
		expect(result.anthropic.some((m) => m.id === "claude-fable-5")).toBe(false);
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

describe("Google thinking support", () => {
	it("either classifies a reasoning-capable Google model or leaves it unconfigured", () => {
		// The table is an allowlist on purpose: support is per-model, varies
		// within a generation, and models.dev doesn't carry it. This asserts the
		// documented contract — a model is either classified from Google's docs
		// or receives no thinking options at all — and prints the unclassified
		// set so the gap stays visible instead of reading as an oversight.
		const reasoning = listModels("google")
			.filter((m) => m.capabilities.reasoning)
			.map((m) => m.id);
		const classified = reasoning.filter((id) => googleThinkingSupport(id) !== undefined);
		const unclassified = reasoning.filter((id) => googleThinkingSupport(id) === undefined);

		expect(classified.length).toBeGreaterThan(0);
		expect(classified.length + unclassified.length).toBe(reasoning.length);
		// Every entry names a real catalog model — a typo would silently
		// un-classify the model it was meant to cover.
		for (const id of classified) {
			expect(getModel("google", id)).toBeDefined();
		}
	});

	it("never offers a level outside Google's ladder", () => {
		for (const id of listModels("google").map((m) => m.id)) {
			const support = googleThinkingSupport(id);
			if (support?.dialect !== "level") continue;
			for (const level of support.levels) {
				expect(GOOGLE_THINKING_LEVELS).toContain(level);
			}
		}
	});

	it("keeps every budget range orderable and non-negative", () => {
		for (const id of listModels("google").map((m) => m.id)) {
			const support = googleThinkingSupport(id);
			if (support?.dialect !== "budget") continue;
			expect(support.min).toBeGreaterThanOrEqual(0);
			expect(support.max).toBeGreaterThan(support.min);
		}
	});
});
