/**
 * briefing-collector — covers the canonical empty-facet string contract
 * that the briefing-generator's `isEmptyFacetData` heuristic depends on.
 *
 * Background: `resolveEntityFacet` (private to briefing-collector.ts)
 * returns `"0 matching ${entity} entities (0 total)"` for both
 * missing-dir and missing-entity-dir cases. The LLM prompt rule
 * ("skip empty or zero facets") and the heuristic fallback's
 * `isEmptyFacetData` regex (`/^(\d+)\s+matching/`) both depend on
 * that exact string shape. If either side drifts the format,
 * missing-dir facets silently become content the briefing narrates
 * back to the user — the exact regression that triggered the
 * "no data yet" briefing on a workspace full of data.
 *
 * Tests go through `collectBriefingFacets` (the public API) rather
 * than poking the private resolver directly.
 */
import { describe, expect, it } from "bun:test";
import {
	type BriefingContext,
	collectBriefingFacets,
} from "../../src/services/briefing-collector.ts";
import type { BundleInstance } from "../../src/bundles/types.ts";
import type { ToolRegistry } from "../../src/tools/registry.ts";

/** Minimal ToolRegistry stub — entity facets never call it. */
function stubRegistry(): ToolRegistry {
	return {
		getSources: () => [],
		execute: async () => ({ content: [], isError: false }),
	} as unknown as ToolRegistry;
}

function makeInstance(overrides: Partial<BundleInstance> = {}): BundleInstance {
	return {
		serverName: "synapse-crm",
		bundleName: "@nimblebraininc/synapse-crm",
		version: "0.0.0",
		state: "running",
		trustScore: null,
		ui: { name: "CRM", icon: "users", placements: [] },
		briefing: {
			priority: "medium",
			facets: [
				{
					name: "overdue",
					label: "Overdue",
					type: "attention",
					entity: "interaction",
				},
			],
		},
		httpProxy: null,
		protected: false,
		type: "upjack",
		wsId: "ws_test",
		...overrides,
	} as BundleInstance;
}

const period = { since: "2026-04-13T00:00:00Z", until: "2026-04-14T00:00:00Z" };

describe("briefing-collector empty-facet contract", () => {
	it("emits canonical zero-pattern when entityDataRoot directory is missing", async () => {
		// entityDataRoot points at a path that doesn't exist on disk.
		// The collector should not leak the filesystem path into the
		// returned data string — it should normalize to the same
		// "0 matching ... (0 total)" shape an empty-but-present dir
		// would produce.
		const instance = makeInstance({
			entityDataRoot: "/tmp/__nb_briefing_collector_does_not_exist__/data",
		});

		const ctx: BriefingContext = await collectBriefingFacets(
			[instance],
			stubRegistry(),
			period,
		);

		expect(ctx.facets).toHaveLength(1);
		const f = ctx.facets[0];
		expect(f).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: presence asserted above
		expect(f!.ok).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: presence asserted above
		expect(f!.data).toBe("0 matching interaction entities (0 total)");
		// biome-ignore lint/style/noNonNullAssertion: presence asserted above
		expect(f!.data).not.toContain("/tmp/"); // no path leak
	});

	it("emits canonical zero-pattern when entity plural dir is missing", async () => {
		// entityDataRoot exists but contains no `interactions/` (or
		// any other plural variant) subdirectory. Use /tmp itself as a
		// directory that exists but doesn't host the entity plural we
		// ask for. /tmp may contain unrelated files; the collector
		// should still return the canonical zero shape.
		const instance = makeInstance({
			entityDataRoot: "/tmp",
			briefing: {
				priority: "medium",
				facets: [
					{
						name: "obscure",
						label: "Obscure",
						type: "activity",
						entity: "wibblywobbly", // no /tmp/wibblywobblys etc. plural will exist
					},
				],
			},
		});

		const ctx: BriefingContext = await collectBriefingFacets(
			[instance],
			stubRegistry(),
			period,
		);

		expect(ctx.facets).toHaveLength(1);
		const f = ctx.facets[0];
		// biome-ignore lint/style/noNonNullAssertion: presence asserted above
		expect(f!.data).toBe("0 matching wibblywobbly entities (0 total)");
	});

	it("matches the empty-facet pattern the heuristic skips", async () => {
		// Ties the contract together: whatever string the collector
		// returns for a missing dir must satisfy the generator's
		// `isEmptyFacetData` regex (^(\d+)\s+matching with N=0), or
		// the heuristic fallback will treat missing data as content.
		const instance = makeInstance({
			entityDataRoot: "/tmp/__nb_briefing_collector_does_not_exist__/data",
		});

		const ctx = await collectBriefingFacets([instance], stubRegistry(), period);

		const f = ctx.facets[0];
		expect(f).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: presence asserted above
		const m = f!.data.match(/^(\d+)\s+matching/);
		expect(m).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: regex match asserted above
		expect(m![1]).toBe("0");
	});

});
