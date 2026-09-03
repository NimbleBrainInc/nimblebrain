/**
 * briefing-collector — covers the resolution contract now that every facet is
 * answered over MCP.
 *
 * A facet names a `resource` or a `tool` on the server that declared it; the
 * host asks that server. There is no host-side disk query, so a facet with
 * neither falls back to its `description` rather than the host inventing a
 * count from files it happens to be able to read.
 */
import { describe, expect, it } from "bun:test";
import { type BriefingContext, collectBriefingFacets } from "../../src/services/briefing-collector.ts";
import type { BriefingFacet, BundleInstance } from "../../src/bundles/types.ts";
import type { ToolRegistry } from "../../src/tools/registry.ts";

/** Registry stub recording the tool call a `tool` facet makes. */
function stubRegistry(calls: Array<{ name: string; input: unknown }> = []): ToolRegistry {
	return {
		getSources: () => [],
		execute: async (call: { name: string; input: unknown }) => {
			calls.push({ name: call.name, input: call.input });
			return { content: [{ type: "text", text: "7 open" }], isError: false };
		},
	} as unknown as ToolRegistry;
}

function makeInstance(facets: BriefingFacet[]): BundleInstance {
	return {
		serverName: "crm",
		bundleName: "crm",
		version: "0.0.0",
		state: "running",
		ui: { name: "CRM", icon: "users", placements: [] },
		briefing: { priority: "medium", facets },
		wsId: "ws_test",
	} as BundleInstance;
}

const period = { since: "2026-04-13T00:00:00Z", until: "2026-04-14T00:00:00Z" };

describe("briefing-collector facet resolution", () => {
	it("resolves a tool facet by calling the declared tool", async () => {
		const calls: Array<{ name: string; input: unknown }> = [];
		const instance = makeInstance([
			{
				name: "open_deals",
				label: "Open deals",
				type: "kpi",
				tool: "crm__count_deals",
				tool_input: { stage: "open" },
			},
		]);

		const ctx: BriefingContext = await collectBriefingFacets(
			[instance],
			stubRegistry(calls),
			period,
		);

		expect(ctx.facets).toHaveLength(1);
		expect(ctx.facets[0]?.ok).toBe(true);
		expect(ctx.facets[0]?.data).toBe("7 open");
		expect(calls).toEqual([{ name: "crm__count_deals", input: { stage: "open" } }]);
	});

	it("falls back to the facet description when neither resource nor tool is declared", async () => {
		const instance = makeInstance([
			{
				name: "overdue",
				label: "Overdue",
				type: "attention",
				description: "Nothing overdue.",
			},
		]);

		const ctx = await collectBriefingFacets([instance], stubRegistry(), period);

		expect(ctx.facets[0]?.ok).toBe(true);
		expect(ctx.facets[0]?.data).toBe("Nothing overdue.");
	});

	it("reports a facet with no data source and no description without throwing", async () => {
		const instance = makeInstance([{ name: "mystery", label: "Mystery", type: "activity" }]);

		const ctx = await collectBriefingFacets([instance], stubRegistry(), period);

		expect(ctx.facets[0]?.ok).toBe(true);
		expect(ctx.facets[0]?.data).toBe("Mystery: no data source configured");
	});

	it("skips connectors that are not running", async () => {
		const instance = makeInstance([
			{ name: "x", label: "X", type: "kpi", tool: "crm__x" },
		]);
		instance.state = "dead";

		const ctx = await collectBriefingFacets([instance], stubRegistry(), period);

		expect(ctx.facets).toEqual([]);
	});
});
