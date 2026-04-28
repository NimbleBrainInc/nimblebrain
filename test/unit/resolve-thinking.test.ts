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

	it("defaults to adaptive for catalog-flagged reasoning models", () => {
		// Opus 4.7 has capabilities.reasoning = true in the catalog.
		expect(resolveThinking({ model: "anthropic:claude-opus-4-7" })).toEqual({
			mode: "adaptive",
		});
	});

	it("operator config wins over model default", () => {
		expect(
			resolveThinking({
				configMode: "off",
				model: "anthropic:claude-opus-4-7",
			}),
		).toEqual({ mode: "off" });
	});

	it("operator config can enable thinking on a non-reasoning model", () => {
		expect(
			resolveThinking({
				configMode: "enabled",
				model: "anthropic:claude-3-5-haiku-20241022",
				configBudgetTokens: 4000,
			}),
		).toEqual({ mode: "enabled", budgetTokens: 4000 });
	});

	it("ignores zero / negative budget tokens", () => {
		const r = resolveThinking({ configMode: "enabled", configBudgetTokens: 0 });
		expect(r).toEqual({ mode: "enabled" });
	});

	it("budgetTokens omitted when not provided", () => {
		const r = resolveThinking({ configMode: "enabled" });
		expect(r).toEqual({ mode: "enabled" });
	});
});
