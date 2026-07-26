import { describe, expect, it } from "bun:test";
import { DEFAULT_THINKING_EFFORT } from "../../src/engine/types.ts";
import { log } from "../../src/observability/log.ts";
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
			source: "platform",
		});
	});

	it("uses the operator's effort tier on the default path", () => {
		expect(
			resolveThinking({ model: "anthropic:claude-opus-4-7", configEffort: "xhigh" }),
		).toEqual({ mode: "effort", effort: "xhigh", source: "operator" });
	});

	it("never reads an output ceiling", () => {
		// The regression this whole shape exists to prevent: with no operator
		// ceiling, `maxOutputTokens` is the model's own catalog maximum, and
		// sizing thinking from it turned a number nobody chose into a directive
		// to reason maximally on every call. The resolver no longer accepts the
		// value at all, so the same input can only produce one answer.
		const small = resolveThinking({ model: "anthropic:claude-opus-5" });
		const large = resolveThinking({ model: "anthropic:claude-opus-4-7" });
		expect(small).toEqual({ mode: "effort", effort: DEFAULT_THINKING_EFFORT, source: "platform" });
		expect(large).toEqual(small);
	});

	it("distinguishes an operator tier from a configured mode from nothing at all", () => {
		// Three states, not two: only a named tier may override a provider's own
		// default, but a configured mode is still operator intent worth
		// reporting when it can't be honored. Collapsing them to one boolean
		// gets one of those two wrong — it did, in both directions at once.
		const m = "anthropic:claude-sonnet-4-6";
		expect(resolveThinking({ model: m, configEffort: "high" })?.source).toBe("operator");
		expect(resolveThinking({ model: m, configMode: "enabled" })?.source).toBe("mode");
		expect(resolveThinking({ model: m, configBudgetTokens: 8000 })?.source).toBe("mode");
		expect(resolveThinking({ model: m })?.source).toBe("platform");
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

	it("warns once when it drops an explicit override for an unknown model", () => {
		// A model absent from the catalog is a supported configuration — pinned
		// ids and OpenAI-compatible proxies with their own names both land here
		// (see resolveModelString). Dropping the operator's instruction silently
		// leaves no way to tell reasoning is off; the warning names the model,
		// which is the whole diagnosis.
		const warnings: string[] = [];
		const original = log.warn;
		(log as { warn: (m: string) => void }).warn = (m: string) => warnings.push(m);
		try {
			const model = `anthropic:proxy-model-${Math.random()}`;
			expect(resolveThinking({ configMode: "enabled", model })).toBeUndefined();
			expect(resolveThinking({ configMode: "enabled", model })).toBeUndefined();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain(model);
			// `off` asks for no reasoning and gets exactly that — nothing to report.
			expect(resolveThinking({ configMode: "off", model: `${model}-b` })).toBeUndefined();
			expect(warnings).toHaveLength(1);
		} finally {
			(log as { warn: (m: string) => void }).warn = original;
		}
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
		).toEqual({ mode: "enabled", budgetTokens: 8000, effort: "max", source: "operator" });
	});

	it("honors a budget set without a thinking mode", () => {
		expect(
			resolveThinking({ configBudgetTokens: 8000, model: "anthropic:claude-opus-4-7" }),
		).toEqual({
			mode: "enabled",
			budgetTokens: 8000,
			effort: DEFAULT_THINKING_EFFORT,
			source: "mode",
		});
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
			source: "mode",
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
			source: "mode",
		});
	});

	it("enabled with nothing else falls back to the default tier", () => {
		expect(
			resolveThinking({ configMode: "enabled", model: "anthropic:claude-sonnet-4-6" }),
		).toEqual({
			mode: "effort",
			effort: DEFAULT_THINKING_EFFORT,
			source: "mode",
		});
	});
});
