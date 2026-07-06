import { describe, expect, it } from "bun:test";
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
});
