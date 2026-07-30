import { describe, expect, it } from "bun:test";
import {
	GOOGLE_THINKING_LEVELS,
	findProviderForModelId,
	getAvailableModels,
	getModel,
	getModelByString,
	getProviderName,
	googleThinkingModelIds,
	googleThinkingSupport,
	isModelAllowed,
	listModels,
	listProviders,
	openaiAcceptsMinimalEffort,
	openaiRestrictedEffortModelIds,
	openaiSupportedEfforts,
	openaiUnmeasuredReasoningModels,
	supportsEnabledThinking,
	xaiEffortModelIds,
	xaiSupportedEfforts,
	xaiUnmeasuredReasoningModels,
} from "../../src/model/catalog.ts";
import { estimateCost } from "../../src/usage/cost.ts";

describe("Model Catalog", () => {
	it("listProviders returns anthropic, openai, google", () => {
		const providers = listProviders();
		expect(providers).toContain("anthropic");
		expect(providers).toContain("openai");
		expect(providers).toContain("google");
		expect(providers).toContain("greenpt");
	});

	it("getProviderName returns display names", () => {
		expect(getProviderName("anthropic")).toBe("Anthropic");
		expect(getProviderName("openai")).toBe("OpenAI");
		expect(getProviderName("google")).toBe("Google");
		expect(getProviderName("greenpt")).toBe("GreenPT");
		expect(getProviderName("unknown")).toBe("unknown");
	});

	it("includes GreenPT flagship and coding models", () => {
		const models = listModels("greenpt");
		expect(models.map((model) => model.id)).toEqual(["glm-5.2", "kimi-k2.7-code", "kimi-k3"]);
		expect(getModel("greenpt", "glm-5.2")?.limits.context).toBe(1_000_000);
		expect(getModel("greenpt", "kimi-k3")?.capabilities.attachment).toBe(true);
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

	it("returns greenpt for a GreenPT flagship model id", () => {
		expect(findProviderForModelId("glm-5.2")).toBe("greenpt");
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
		// Iterate the TABLE's keys, not the catalog's. Going the other way is
		// vacuous: a typo'd key matches no catalog id, so it never appears in
		// the derived set and the assertion never sees it — the model it meant
		// to cover just silently loses its thinking options, which is
		// indistinguishable from a deliberate omission.
		const ids = googleThinkingModelIds();
		expect(ids.length).toBeGreaterThan(0);
		const unknown = ids.filter((id) => getModel("google", id) === undefined);
		expect(unknown).toEqual([]);
	});

	it("classifies the mainstream Gemini models, with the levels Google publishes", () => {
		// The table's contents were untested, so a missing row looked exactly
		// like a deliberate omission — gemini-3.1-flash-lite sat unclassified
		// for several rounds under a comment asserting Google didn't document
		// it, which turned out to be true of one docs page and false of the
		// other. These rows are transcribed from Google's tables; changing one
		// should require changing this list and citing the source.
		const expected: Record<string, string[]> = {
			"gemini-3.6-flash": ["minimal", "low", "medium", "high"],
			"gemini-3.5-flash": ["minimal", "low", "medium", "high"],
			"gemini-3.5-flash-lite": ["minimal", "low", "medium", "high"],
			"gemini-3-flash-preview": ["minimal", "low", "medium", "high"],
			"gemini-3.1-flash-lite": ["minimal", "low", "medium", "high"],
			"gemini-3.1-pro-preview": ["low", "medium", "high"],
			"gemini-3-pro-preview": ["low", "high"],
			"gemini-3.1-flash-lite-image": ["minimal", "high"],
		};
		for (const [id, levels] of Object.entries(expected)) {
			const support = googleThinkingSupport(id);
			expect(`${id}: ${support?.dialect}`).toBe(`${id}: level`);
			if (support?.dialect !== "level") continue;
			expect(`${id}: ${[...support.levels].sort().join(",")}`).toBe(
				`${id}: ${[...levels].sort().join(",")}`,
			);
		}
		// The 2.5 line is budget-shaped and must stay that way; see the row
		// comment for the conflicting sources.
		for (const id of ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]) {
			expect(`${id}: ${googleThinkingSupport(id)?.dialect}`).toBe(`${id}: budget`);
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
			// googleBudgetOptions floors at max(support.min, 1024), so a row whose
			// ceiling is below that floor would emit a budget above the model's
			// own documented maximum.
			expect(support.max).toBeGreaterThanOrEqual(1024);
		}
	});
});

describe("OpenAI effort support", () => {
	it("names real catalog models in the OpenAI restricted-effort map", () => {
		// Same failure mode as the Google table: a typo'd key silently restores
		// the full ladder for the model it meant to restrict, and gpt-5-pro
		// would go back to 400ing on the platform default.
		const ids = openaiRestrictedEffortModelIds();
		expect(ids.length).toBeGreaterThan(0);
		expect(ids.filter((id) => getModel("openai", id) === undefined)).toEqual([]);
		// Measured against /v1/responses, not taken from docs.
		expect([...openaiSupportedEfforts("openai:gpt-5-pro")]).toEqual(["high"]);
		// Bounded from ABOVE as well as below — restriction is not a `-pro`
		// property and not always a floor.
		expect([...openaiSupportedEfforts("openai:gpt-5.2-chat-latest")]).toEqual(["medium"]);
		expect([...openaiSupportedEfforts("openai:gpt-5.2-pro")].sort()).toEqual(["high", "medium"]);
		// `minimal` rides in the same table rather than a parallel set, so it
		// inherits the typo and coverage guards. It is not in OPENAI_EFFORTS, so
		// step-down can never land on it.
		expect([...openaiSupportedEfforts("openai:gpt-5")].sort()).toEqual([
			"high",
			"low",
			"medium",
			"minimal",
		]);
		expect(openaiAcceptsMinimalEffort("openai:gpt-5")).toBe(true);
		expect(openaiAcceptsMinimalEffort("openai:gpt-5.1")).toBe(false);
		// Anything unlisted takes the full ladder, and never minimal.
		expect([...openaiSupportedEfforts("openai:not-a-model")].sort()).toEqual([
			"high",
			"low",
			"medium",
		]);
	});

	it("has measured every catalog reasoning model", () => {
		// The map's default is the opposite of Google's — absent means the FULL
		// ladder — so a model `sync-models` adds tomorrow silently gets all three
		// tiers and 400s in production if it is actually restricted. This fails
		// CI instead. Note the guard cannot be "every -pro id has a row":
		// o3-pro is -pro, was measured, and correctly takes the full ladder.
		expect(openaiUnmeasuredReasoningModels()).toEqual([]);
	});
});

describe("xai effort support", () => {
	it("classifies only real catalog models", () => {
		for (const id of xaiEffortModelIds()) {
			expect(getModel("xai", id), `${id} is not in the catalog`).toBeDefined();
		}
	});

	it("has measured every catalog reasoning model", () => {
		// Fail-closed, so an unmeasured model degrades to "no reasoning options"
		// rather than a 400 — the safe direction, unlike OpenAI's permissive
		// default. Still a gap: a newly-synced Grok would silently never reason.
		//
		// When this fails, the per-model tier table in
		// docs/src/content/docs/config/nimblebrain-json.mdx needs the same row —
		// it is the user-facing copy of this table and nothing else points at it.
		expect(xaiUnmeasuredReasoningModels()).toEqual([]);
	});

	it("gives an unlisted model no options at all", () => {
		// The opposite of `openaiSupportedEfforts`, which hands an unknown id the
		// full ladder. Two models on this provider reject every tier, so a
		// permissive default would 400 rather than degrade.
		expect(xaiSupportedEfforts("xai:not-a-model")).toBeUndefined();
	});

	it("records `none` only where it is measured to work", () => {
		// grok-4.3 accepts it and returns reasoning_tokens: 0; grok-4.5 rejects
		// that specific value while accepting the tiers above it.
		expect(xaiSupportedEfforts("xai:grok-4.3")?.has("none")).toBe(true);
		expect(xaiSupportedEfforts("xai:grok-4.5")?.has("none")).toBe(false);
		expect([...(xaiSupportedEfforts("xai:grok-4.5") ?? [])].sort()).toEqual([
			"high",
			"low",
			"medium",
		]);
	});

	it("records an empty ladder for a model that reasons without a knob", () => {
		// The flag says whether the model reasons, the table says whether you can
		// ask it to. Flipping the flag to dodge the 400 would misreport reasoning
		// cost. A model that does not reason needs no row at all — `resolveThinking`
		// drops the override on the capability flag, so the builder never runs.
		expect(xaiSupportedEfforts("xai:grok-4.20-0309-reasoning")?.size).toBe(0);
		expect(getModel("xai", "grok-4.20-0309-reasoning")?.capabilities.reasoning).toBe(true);
		expect(getModel("xai", "grok-4.20-0309-non-reasoning")?.capabilities.reasoning).toBe(false);
		expect(xaiSupportedEfforts("xai:grok-4.20-0309-non-reasoning")).toBeUndefined();
	});

	it("keeps every model's max output under its context window", () => {
		// xAI publishes no max-output cap and accepts max_tokens up to the full
		// window, which upstream reports as output == context. Any such model
		// resolves a zero message budget and fails every turn, so sync-models
		// caps the whole provider by rule.
		//
		// Asserted over the catalog rather than a list of ids: enumerating the
		// two models that need it today would pass unchanged on the next Grok
		// that arrives the same way, which is the case worth catching.
		//
		// This checks the shipped artifact. The rule that produces it is tested
		// in sync-models.test.ts — this one stays green if the rule is deleted,
		// because the committed data is already capped.
		const models = listModels("xai");
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) {
			expect(m.limits.output, `${m.id} output must be under its context`).toBeLessThan(
				m.limits.context,
			);
		}
	});

	it("excludes the multi-agent model, which chat completions refuses", () => {
		expect(getModel("xai", "grok-4.20-multi-agent-0309")).toBeUndefined();
	});
});
