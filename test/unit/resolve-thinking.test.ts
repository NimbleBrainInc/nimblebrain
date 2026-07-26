import { describe, expect, it } from "bun:test";
import { DEFAULT_THINKING_EFFORT } from "../../src/engine/types.ts";
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

	it("defaults reasoning models to the default effort tier", () => {
		// The platform default states a depth rather than a token budget, so it
		// carries the same meaning to every provider.
		expect(resolveThinking({ model: "anthropic:claude-opus-4-7" })).toEqual({
			mode: "effort",
			effort: DEFAULT_THINKING_EFFORT,
		});
	});

	it("uses the operator's effort tier on the default path", () => {
		expect(
			resolveThinking({ model: "anthropic:claude-opus-4-7", configEffort: "xhigh" }),
		).toEqual({ mode: "effort", effort: "xhigh" });
	});

	it("never reads an output ceiling", () => {
		// The regression this whole shape exists to prevent: with no operator
		// ceiling, `maxOutputTokens` is the model's own catalog maximum, and
		// sizing thinking from it turned a number nobody chose into a directive
		// to reason maximally on every call. The resolver no longer accepts the
		// value at all, so the same input can only produce one answer.
		const small = resolveThinking({ model: "anthropic:claude-opus-5" });
		const large = resolveThinking({ model: "anthropic:claude-opus-4-7" });
		expect(small).toEqual({ mode: "effort", effort: DEFAULT_THINKING_EFFORT });
		expect(large).toEqual(small);
	});

	it("operator off wins over model default", () => {
		expect(resolveThinking({ configMode: "off", model: "anthropic:claude-opus-4-7" })).toEqual({
			mode: "off",
		});
	});

	it("operator adaptive is passed through bare", () => {
		expect(
			resolveThinking({ configMode: "adaptive", model: "anthropic:claude-opus-4-7" }),
		).toEqual({ mode: "adaptive" });
	});

	it("drops effort and budget on adaptive", () => {
		// Adaptive means "you decide". Attaching a depth or a cap to it states
		// two contradictory things, so the mode wins and the rest is dropped.
		expect(
			resolveThinking({
				configMode: "adaptive",
				configEffort: "max",
				configBudgetTokens: 8000,
				model: "anthropic:claude-opus-4-7",
			}),
		).toEqual({ mode: "adaptive" });
	});

	it("refuses to enable thinking on a model the catalog says can't", () => {
		// An override can ask for reasoning; it cannot make the parameter exist.
		// This gate used to be skipped for explicit `enabled`, which was inert
		// while the engine dropped every non-Anthropic provider and became a
		// live wrong-parameter send once OpenAI and Nebius were wired — Nebius
		// hosts non-reasoning open-weight models and its adapter forwards
		// `reasoning_effort` without a gate of its own.
		for (const model of [
			"anthropic:claude-3-5-haiku-20241022",
			"nebius:meta-llama/Llama-3.3-70B-Instruct",
		]) {
			expect(resolveThinking({ configMode: "enabled", model })).toBeUndefined();
			expect(resolveThinking({ configMode: "adaptive", model })).toBeUndefined();
			expect(resolveThinking({ configMode: "off", model })).toBeUndefined();
		}
	});

	it("carries the tier alongside an explicit budget", () => {
		// Not alternatives: the budget meters thinking where a provider counts
		// tokens, and the tier is what every other provider uses. Dropping the
		// tier here made the depth control inert on the effort-shaped models it
		// was added for, because the settings UI sends a budget on every save.
		expect(
			resolveThinking({
				configMode: "enabled",
				configEffort: "max",
				configBudgetTokens: 8000,
				model: "anthropic:claude-sonnet-4-6",
			}),
		).toEqual({ mode: "enabled", budgetTokens: 8000, effort: "max" });
	});

	it("honors a budget set without a thinking mode", () => {
		expect(
			resolveThinking({ configBudgetTokens: 8000, model: "anthropic:claude-opus-4-7" }),
		).toEqual({ mode: "enabled", budgetTokens: 8000, effort: DEFAULT_THINKING_EFFORT });
	});

	it("passes an operator budget through verbatim", () => {
		// The resolver states intent; the engine clamps it against the output
		// ceiling, because only the engine knows whether the provider meters
		// tokens at all. See the engine's clamp test for the enforcement.
		expect(resolveThinking({
			configMode: "enabled",
			configBudgetTokens: 50_000,
			model: "anthropic:claude-sonnet-4-6",
		})).toEqual({
			mode: "enabled",
			budgetTokens: 50_000,
			effort: DEFAULT_THINKING_EFFORT,
		});
	});

	it("zero / negative budget tokens are ignored (treated as unset)", () => {
		expect(resolveThinking({
			configMode: "enabled",
			configBudgetTokens: 0,
			model: "anthropic:claude-sonnet-4-6",
		})).toEqual({
			mode: "effort",
			effort: DEFAULT_THINKING_EFFORT,
		});
	});

	it("enabled with nothing else falls back to the default tier", () => {
		expect(
			resolveThinking({ configMode: "enabled", model: "anthropic:claude-sonnet-4-6" }),
		).toEqual({
			mode: "effort",
			effort: DEFAULT_THINKING_EFFORT,
		});
	});
});
