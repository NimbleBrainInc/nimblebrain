import { describe, expect, it } from "bun:test";
import { textContent } from "../../../src/engine/content-helpers.ts";
import { INTERNAL_TOOL_ANNOTATION } from "../../../src/engine/types.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import { rankToolSearchResults } from "../../../src/tools/search-ranking.ts";
import { makeInProcessSource } from "../../helpers/in-process-source.ts";

// Plain ToolSearchResult fixtures (name + description) — the ranker only
// reads those two fields.
const CANDIDATES = [
	{ name: "synapse-crm__create_contact", description: "Create a CRM contact" },
	{ name: "synapse-todo-board__create_board_task", description: "Create a task on a todo board" },
	{ name: "synapse-todo-board__list_boards", description: "List the todo boards in a workspace" },
];

describe("rankToolSearchResults", () => {
	it("matches a multi-term natural-language query against a tokenized tool name", () => {
		// The literal full-query substring "todo task create" appears in no name
		// or description; tokenized matching is what surfaces the right tool.
		const ranked = rankToolSearchResults(CANDIDATES, "todo task create");
		expect(ranked[0]?.name).toBe("synapse-todo-board__create_board_task");
	});

	it("ranks full query-term coverage above partial coverage", () => {
		// "create_board_task" covers all three terms; the other two candidates
		// cover one each ("todo" / "create"), so the full-coverage tool must
		// sort strictly ahead of both.
		const ranked = rankToolSearchResults(CANDIDATES, "todo task create");
		expect(ranked.length).toBe(3);
		expect(ranked[0]?.name).toBe("synapse-todo-board__create_board_task");
	});

	it("folds simple plurals so a singular query matches a plural token", () => {
		// "board" must reach "...__list_boards" via the plural variant.
		const ranked = rankToolSearchResults(CANDIDATES, "board");
		expect(ranked.some((t) => t.name === "synapse-todo-board__list_boards")).toBe(true);
	});

	it("excludes tools that match no query term", () => {
		const ranked = rankToolSearchResults(CANDIDATES, "zzznomatch");
		expect(ranked).toEqual([]);
	});

	it("returns the input unchanged for an empty query (browse passthrough)", () => {
		const ranked = rankToolSearchResults(CANDIDATES, "");
		expect(ranked).toBe(CANDIDATES);
	});
});

describe("ToolRegistry invalid-tool-name suggestions", () => {
	it("reuses ranked search to suggest the namespaced tool for a bare name", async () => {
		// Exercises the "Did you mean?" path: a bare (prefix-less) name routes
		// through searchTools → rankToolSearchResults and surfaces the correct
		// namespaced suggestion. Locks the PR-body claim that invalid-name
		// suggestions reuse the same ranked search.
		const registry = new ToolRegistry();
		registry.addSource(
			await makeInProcessSource("synapse-todo-board", [
				{
					name: "create_board_task",
					description: "Create a task on a todo board",
					inputSchema: { type: "object", properties: {} },
					handler: async () => ({ content: textContent("ok"), isError: false }),
				},
			]),
		);

		const result = await registry.execute({
			id: "t1",
			name: "create_board_task",
			input: {},
		});

		expect(result.isError).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("Did you mean");
		expect(text).toContain("synapse-todo-board__create_board_task");
	});

	it("never suggests an internal tool", async () => {
		// The hint writes matched names AND descriptions into the model's
		// context, so it is a tool-listing surface like any other. An
		// `ai.nimblebrain/internal` tool is a UI-driven affordance the model
		// must never be handed — it is stripped from chat surfacing,
		// `nb__search`, promotion, and `/mcp` tools/list, and this is the
		// remaining path that could name one back. The bare query below is an
		// exact token match for the internal tool, so a missing filter surfaces
		// it at rank 1.
		const registry = new ToolRegistry();
		registry.addSource(
			await makeInProcessSource("instructions", [
				{
					name: "write_instructions",
					description: "Save workspace-wide custom instructions",
					meta: { [INTERNAL_TOOL_ANNOTATION]: true },
					inputSchema: { type: "object", properties: {} },
					handler: async () => ({ content: textContent("ok"), isError: false }),
				},
			]),
		);

		const result = await registry.execute({
			id: "t2",
			name: "write_instructions",
			input: {},
		});

		expect(result.isError).toBe(true);
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).not.toContain("instructions__write_instructions");
		expect(text).not.toContain("Did you mean");
	});
});
