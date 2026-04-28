import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../../src/limits.ts";
import { getModelByString } from "../../src/model/catalog.ts";
import { resolveMaxOutputTokens } from "../../src/runtime/resolve-max-output-tokens.ts";

describe("resolveMaxOutputTokens", () => {
	it("returns DEFAULT_MAX_OUTPUT_TOKENS when nothing is supplied", () => {
		expect(resolveMaxOutputTokens({})).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
	});

	it("returns DEFAULT_MAX_OUTPUT_TOKENS when model is not in catalog", () => {
		expect(resolveMaxOutputTokens({ model: "anthropic:made-up-model" })).toBe(
			DEFAULT_MAX_OUTPUT_TOKENS,
		);
	});

	it("uses the model's catalog limits.output as the default", () => {
		const opus = getModelByString("anthropic:claude-opus-4-7");
		expect(opus).toBeDefined();
		expect(resolveMaxOutputTokens({ model: "anthropic:claude-opus-4-7" })).toBe(
			opus!.limits.output,
		);
	});

	it("operator config override below the model max wins", () => {
		expect(
			resolveMaxOutputTokens({
				configValue: 8_000,
				model: "anthropic:claude-opus-4-7",
			}),
		).toBe(8_000);
	});

	it("operator config override above the model max is clamped to the model max", () => {
		const opus = getModelByString("anthropic:claude-opus-4-7");
		expect(
			resolveMaxOutputTokens({
				configValue: 10_000_000,
				model: "anthropic:claude-opus-4-7",
			}),
		).toBe(opus!.limits.output);
	});

	it("operator config override is trusted as-is when model is unknown", () => {
		expect(
			resolveMaxOutputTokens({
				configValue: 100_000,
				model: "anthropic:made-up-model",
			}),
		).toBe(100_000);
	});

	it("zero or negative config override falls through to the catalog default", () => {
		expect(
			resolveMaxOutputTokens({
				configValue: -1,
				model: "anthropic:claude-opus-4-7",
			}),
		).toBe(getModelByString("anthropic:claude-opus-4-7")!.limits.output);
	});

	it("bare model strings (no provider prefix) are treated as anthropic", () => {
		const opus = getModelByString("anthropic:claude-opus-4-7");
		expect(resolveMaxOutputTokens({ model: "claude-opus-4-7" })).toBe(opus!.limits.output);
	});
});
