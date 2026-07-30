import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../../src/limits.ts";
import { buildProviderModels } from "../../src/model/sync-models.ts";

// Minimal raw-model shape with the fields buildProviderModels reads. The map
// key (not `id`) drives exclusion/override lookups and the catalog id, so the
// literal id here is arbitrary.
function raw(overrides: Record<string, unknown> = {}) {
	return {
		id: "x",
		name: "X",
		cost: { input: 3, output: 15 },
		limit: { context: 1_000_000, output: 64_000 },
		...overrides,
	};
}

function provider(models: Record<string, unknown>) {
	// biome-ignore lint/suspicious/noExplicitAny: test fixture, RawProvider shape
	return { id: "anthropic", name: "Anthropic", models } as any;
}

describe("buildProviderModels", () => {
	it("drops manually-excluded models (Fable 5) at sync time", () => {
		// Exercises the MANUAL_EXCLUSIONS filter directly — the checked-in
		// catalog never contains Fable, so an artifact-level assertion can't.
		const models = buildProviderModels(
			"anthropic",
			provider({ "claude-fable-5": raw(), "claude-sonnet-5": raw() }),
		);
		expect(models["claude-fable-5"]).toBeUndefined();
		expect(models["claude-sonnet-5"]).toBeDefined();
	});

	it("pins beta-gated 1M context to the platform-usable limit", () => {
		const models = buildProviderModels(
			"anthropic",
			provider({
				// Sonnet 4.5's 1M needs a beta header the runtime never sends.
				"claude-sonnet-4-5": raw({ limit: { context: 1_000_000, output: 64_000 } }),
				// Sonnet 4.6 ships 1M as GA — must be left untouched.
				"claude-sonnet-4-6": raw({ limit: { context: 1_000_000, output: 128_000 } }),
			}),
		);
		expect(models["claude-sonnet-4-5"].limits.context).toBe(200_000);
		expect(models["claude-sonnet-4-6"].limits.context).toBe(1_000_000);
	});

	it("skips models without pricing", () => {
		const models = buildProviderModels("anthropic", provider({ "embed-x": raw({ cost: {} }) }));
		expect(models["embed-x"]).toBeUndefined();
	});

	it("caps an xai model that reports no output ceiling of its own", () => {
		// xAI publishes no max-output cap, which upstream renders as
		// `output == context`. Left alone that resolves a zero message budget and
		// every turn fails, so the whole provider is capped by rule.
		const models = buildProviderModels(
			"xai",
			provider({ "grok-x": raw({ limit: { context: 500_000, output: 500_000 } }) }),
		);
		expect(models["grok-x"].limits.output).toBe(DEFAULT_MAX_OUTPUT_TOKENS);
		expect(models["grok-x"].limits.context).toBe(500_000);
	});

	it("leaves an xai model with a real declared ceiling alone", () => {
		// The grok-4.20 line reports 30000 against a 1M window. That is a genuine
		// upstream cap, not the no-ceiling sentinel, so the rule must not touch it.
		const models = buildProviderModels(
			"xai",
			provider({ "grok-y": raw({ limit: { context: 1_000_000, output: 30_000 } }) }),
		);
		expect(models["grok-y"].limits.output).toBe(30_000);
	});

	it("caps no provider but xai", () => {
		// The rule is scoped because "no published cap" is an xAI property. Ten
		// openai/google models report `output >= context` today for unrelated
		// reasons (image and TTS models); widening the rule would silently
		// re-limit all of them. See #844.
		const models = buildProviderModels(
			"google",
			provider({ "gemini-image": raw({ limit: { context: 65_536, output: 65_536 } }) }),
		);
		expect(models["gemini-image"].limits.output).toBe(65_536);
	});
});
