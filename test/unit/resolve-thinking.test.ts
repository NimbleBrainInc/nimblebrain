import { describe, expect, it } from "bun:test";
import { resolveThinking } from "../../src/runtime/resolve-thinking.ts";

describe("resolveThinking", () => {
	it("returns undefined when no config and no model is supplied", () => {
		expect(resolveThinking({})).toBeUndefined();
	});

	it("returns undefined when the model is unknown", () => {
		expect(resolveThinking({ model: "anthropic:made-up-model" })).toBeUndefined();
	});

	it("returns undefined for non-reasoning models when no operator override", () => {
		// claude-3-5-haiku is not a reasoning-capable model in the catalog.
		// Without operator override, the platform doesn't request thinking.
		expect(resolveThinking({ model: "anthropic:claude-3-5-haiku-20241022" })).toBeUndefined();
	});

	it("defaults to enabled-with-capped-budget for catalog-flagged reasoning models", () => {
		// Opus 4.7 has capabilities.reasoning = true. The platform default is
		// `enabled` (not `adaptive`) so we keep direct control over thinking
		// spend; budget is clamped to leave room for visible output.
		expect(
			resolveThinking({ model: "anthropic:claude-opus-4-7", maxOutputTokens: 16384 }),
		).toEqual({ mode: "enabled", budgetTokens: 16384 - 4096 });
	});

	it("default budget floors at 1024 (Anthropic minimum) when maxOutputTokens is tiny", () => {
		// Even when maxOutputTokens is below the visible-tokens floor, we
		// emit at least 1024 — the API rejects anything lower.
		expect(
			resolveThinking({ model: "anthropic:claude-opus-4-7", maxOutputTokens: 2000 }),
		).toEqual({ mode: "enabled", budgetTokens: 1024 });
	});

	it("default budget falls back to 1024 when maxOutputTokens is omitted", () => {
		// Caller didn't pass maxOutputTokens (legacy callsite). Fall back to
		// the safe minimum rather than emitting a budget-less `enabled`,
		// which the SDK rejects with a warning.
		expect(resolveThinking({ model: "anthropic:claude-opus-4-7" })).toEqual({
			mode: "enabled",
			budgetTokens: 1024,
		});
	});

	it("operator off wins over model default", () => {
		expect(
			resolveThinking({
				configMode: "off",
				model: "anthropic:claude-opus-4-7",
				maxOutputTokens: 16384,
			}),
		).toEqual({ mode: "off" });
	});

	it("operator adaptive is passed through (provider picks budget)", () => {
		expect(
			resolveThinking({
				configMode: "adaptive",
				model: "anthropic:claude-opus-4-7",
				maxOutputTokens: 16384,
			}),
		).toEqual({ mode: "adaptive" });
	});

	it("operator adaptive with budget is passed through verbatim", () => {
		// The Anthropic SDK currently drops the budget on adaptive, but we
		// pass it through so a future SDK that honors it gets the value.
		expect(
			resolveThinking({
				configMode: "adaptive",
				configBudgetTokens: 8000,
				model: "anthropic:claude-opus-4-7",
				maxOutputTokens: 16384,
			}),
		).toEqual({ mode: "adaptive", budgetTokens: 8000 });
	});

	it("operator config can enable thinking on a non-reasoning model", () => {
		expect(
			resolveThinking({
				configMode: "enabled",
				model: "anthropic:claude-3-5-haiku-20241022",
				configBudgetTokens: 4000,
				maxOutputTokens: 16384,
			}),
		).toEqual({ mode: "enabled", budgetTokens: 4000 });
	});

	it("operator-set budget on enabled is clamped to leave visible-output room", () => {
		// Operator says "give me 50K of thinking" but maxOutputTokens is 16K.
		// We clamp down so visible content gets at least MIN_VISIBLE_OUTPUT_TOKENS.
		expect(
			resolveThinking({
				configMode: "enabled",
				configBudgetTokens: 50_000,
				maxOutputTokens: 16384,
			}),
		).toEqual({ mode: "enabled", budgetTokens: 16384 - 4096 });
	});

	it("operator-set lower budget is preserved (not raised)", () => {
		// Clamping is one-directional: we lower a too-large budget, never
		// raise a deliberately small one.
		expect(
			resolveThinking({
				configMode: "enabled",
				configBudgetTokens: 2000,
				maxOutputTokens: 16384,
			}),
		).toEqual({ mode: "enabled", budgetTokens: 2000 });
	});

	it("zero / negative budget tokens are ignored (treated as unset)", () => {
		expect(
			resolveThinking({ configMode: "enabled", configBudgetTokens: 0, maxOutputTokens: 16384 }),
		).toEqual({ mode: "enabled", budgetTokens: 16384 - 4096 });
	});

	it("enabled without maxOutputTokens or budget falls back to 1024", () => {
		// Legacy callsite path. Always emit a budget — the SDK rejects
		// `enabled` without one (warning + default of 1024 anyway).
		expect(resolveThinking({ configMode: "enabled" })).toEqual({
			mode: "enabled",
			budgetTokens: 1024,
		});
	});
});
