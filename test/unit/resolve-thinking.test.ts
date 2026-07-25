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
		// Sonnet 4.6 has capabilities.reasoning = true and accepts the
		// `enabled` shape, so it carries a real budget. The platform default is
		// `enabled` (not `adaptive`) so we keep direct control over thinking
		// spend; budget is clamped to leave room for visible output.
		expect(
			resolveThinking({ model: "anthropic:claude-sonnet-4-6", maxOutputTokens: 16384 }),
		).toEqual({ mode: "enabled", budgetTokens: 16384 - 4096 });
	});

	it("default budget floors at 1024 (Anthropic minimum) when maxOutputTokens is tiny", () => {
		// Even when maxOutputTokens is below the visible-tokens floor, we
		// emit at least 1024 — the API rejects anything lower.
		expect(
			resolveThinking({ model: "anthropic:claude-sonnet-4-6", maxOutputTokens: 2000 }),
		).toEqual({ mode: "enabled", budgetTokens: 1024 });
	});

	it("default budget falls back to 1024 when maxOutputTokens is omitted", () => {
		// Caller didn't pass maxOutputTokens (legacy callsite). Fall back to
		// the safe minimum rather than emitting a budget-less `enabled`,
		// which the SDK rejects with a warning.
		expect(resolveThinking({ model: "anthropic:claude-sonnet-4-6" })).toEqual({
			mode: "enabled",
			budgetTokens: 1024,
		});
	});

	it("sends bare adaptive on an adaptive-only model when no ceiling was configured", () => {
		// Adaptive-only models can't carry a budget — the engine turns it into
		// an `output_config.effort` tier. With no operator ceiling,
		// `maxOutputTokens` is the model's own catalog maximum, so deriving a
		// tier from it would request maximum reasoning on every call from a
		// number nobody chose. Emit bare adaptive and let the model decide.
		expect(
			resolveThinking({
				model: "anthropic:claude-opus-5",
				maxOutputTokens: 128000,
				maxOutputTokensConfigured: false,
			}),
		).toEqual({ mode: "adaptive" });
	});

	it("sends bare adaptive for explicit thinking=enabled with no ceiling on an adaptive-only model", () => {
		// The carve-out originally guarded only the no-override path, so an
		// operator who asked for `enabled` still got a tier derived from the
		// catalog ceiling — `effort: "max"` on every call. `enabled` means
		// "always reason", not "reason maximally".
		expect(
			resolveThinking({
				configMode: "enabled",
				model: "anthropic:claude-opus-5",
				maxOutputTokens: 128000,
				maxOutputTokensConfigured: false,
			}),
		).toEqual({ mode: "adaptive" });
	});

	it("derives a budget for thinking=enabled when the operator supplied one", () => {
		expect(
			resolveThinking({
				configMode: "enabled",
				configBudgetTokens: 8000,
				model: "anthropic:claude-opus-5",
				maxOutputTokens: 128000,
			}),
		).toEqual({ mode: "enabled", budgetTokens: 8000 });
	});

	it("keeps the enabled shape on a model that accepts it", () => {
		// The carve-out is adaptive-only; enabled-capable models still get a
		// provider-enforced budget, which is the production fix it must not undo.
		expect(
			resolveThinking({
				configMode: "enabled",
				model: "anthropic:claude-sonnet-4-6",
				maxOutputTokens: 16384,
			}),
		).toEqual({ mode: "enabled", budgetTokens: 16384 - 4096 });
	});

	it("honors a budget set without a thinking mode on an adaptive-only model", () => {
		// The carve-out steps aside when a budget is set, on the grounds that the
		// operator supplied intent. The path it hands off to must then use that
		// budget — substituting the catalog ceiling would re-derive the "max
		// reasoning from a number nobody chose" tier the carve-out exists to
		// prevent, via the very condition that disabled it.
		expect(
			resolveThinking({
				configBudgetTokens: 8000,
				model: "anthropic:claude-opus-5",
				maxOutputTokens: 128000,
				maxOutputTokensConfigured: false,
			}),
		).toEqual({ mode: "enabled", budgetTokens: 8000 });
	});

	it("still derives a budget on an adaptive-only model when the operator set a ceiling", () => {
		// The one case where the number means something: the operator chose it,
		// so the effort tier the engine derives from it reflects intent.
		expect(
			resolveThinking({
				model: "anthropic:claude-opus-5",
				maxOutputTokens: 8000,
				maxOutputTokensConfigured: true,
			}),
		).toEqual({ mode: "enabled", budgetTokens: 8000 - 4096 });
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
