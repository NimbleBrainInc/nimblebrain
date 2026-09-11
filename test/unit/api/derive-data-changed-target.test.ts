import { describe, expect, test } from "bun:test";
import { deriveDataChangedTarget } from "../../../src/api/events.ts";
import type { EngineEvent } from "../../../src/engine/types.ts";

// A valid opaque workspace id (`ws_` + lowercase hex), matching the shape
// `generateWorkspaceId()` produces and `WORKSPACE_ID_RE` accepts.
const WS = "ws_0123456789abcdef";

describe("deriveDataChangedTarget", () => {
	test("tool.done with a workspace-namespaced name emits the BARE server", () => {
		// The regression: post-Stage-2 the model calls `ws_<id>-<source>__<tool>`,
		// and `tool.done` carries that namespaced name. The Synapse `useDataSync`
		// consumer matches `server` against the iframe's bare `data-app`, so a
		// namespaced server never matches and the iframe never refreshes live.
		const event: EngineEvent = {
			type: "tool.done",
			data: { name: `${WS}-synapse-db-query__present_result`, ok: true },
		};
		expect(deriveDataChangedTarget(event)).toEqual({
			server: "synapse-db-query",
			tool: "present_result",
		});
	});

	test("a bare, hyphenated source name is left intact (no over-strip)", () => {
		// `bareToolName` only strips a leading `ws_<id>` segment; `synapse` is not
		// a workspace id, so a hyphenated source name survives unchanged.
		const event: EngineEvent = {
			type: "tool.done",
			data: { name: "synapse-db-query__present_result", ok: true },
		};
		expect(deriveDataChangedTarget(event)).toEqual({
			server: "synapse-db-query",
			tool: "present_result",
		});
	});

	test("tool.progress (bare source + tool) emits the same bare server", () => {
		const event: EngineEvent = {
			type: "tool.progress",
			data: { source: "synapse-db-query", tool: "run_research" },
		};
		expect(deriveDataChangedTarget(event)).toEqual({
			server: "synapse-db-query",
			tool: "run_research",
		});
	});

	test("namespaced system tool (nb) is filtered out", () => {
		// Before the bare-name normalization, `ws_<id>-nb__search` parsed to a
		// server of `ws_<id>-nb` (!== "nb"), so the `nb` guard failed open and
		// system tools wrongly triggered iframe refreshes.
		const event: EngineEvent = {
			type: "tool.done",
			data: { name: `${WS}-nb__search`, ok: true },
		};
		expect(deriveDataChangedTarget(event)).toBeNull();
	});

	test("bare system tool (nb) is filtered out", () => {
		const event: EngineEvent = {
			type: "tool.progress",
			data: { source: "nb", tool: "search" },
		};
		expect(deriveDataChangedTarget(event)).toBeNull();
	});

	test("tool.done with ok:false does not broadcast", () => {
		const event: EngineEvent = {
			type: "tool.done",
			data: { name: `${WS}-synapse-db-query__present_result`, ok: false },
		};
		expect(deriveDataChangedTarget(event)).toBeNull();
	});

	test("unrelated event types do not broadcast", () => {
		expect(deriveDataChangedTarget({ type: "run.start", data: {} })).toBeNull();
	});

	test("a malformed event missing both name and source/tool does not broadcast", () => {
		expect(deriveDataChangedTarget({ type: "tool.done", data: { ok: true } })).toBeNull();
	});

	describe("personal connectors", () => {
		test("a marked source does not broadcast at all", () => {
			// Nothing can be listening: a personal connector mounts no iframe, so no
			// `data-app` carries its name.
			const event: EngineEvent = {
				type: "tool.done",
				data: { name: "my_notes__append", ok: true },
			};
			expect(deriveDataChangedTarget(event)).toBeNull();
		});

		test("the marker is not stripped to find a listener", () => {
			// The load-bearing case. De-marking `my_notes` to `notes` would match the
			// WORKSPACE app of that name and refetch it on the caller's private tool
			// call — the same-name collision the marker exists to prevent, reached
			// through the back door. Assert the workspace app is NOT the target.
			const event: EngineEvent = {
				type: "tool.done",
				data: { name: "my_notes__append", ok: true },
			};
			expect(deriveDataChangedTarget(event)).not.toEqual({
				server: "notes",
				tool: "append",
			});
		});

		test("the same-named WORKSPACE source still broadcasts normally", () => {
			// The marker is what separates them; an unmarked `notes` is the
			// workspace's own app and is unaffected by the guard above.
			const event: EngineEvent = {
				type: "tool.done",
				data: { name: "notes__append", ok: true },
			};
			expect(deriveDataChangedTarget(event)).toEqual({
				server: "notes",
				tool: "append",
			});
		});

		test("a marked source arriving as separate source/tool fields is also refused", () => {
			// `tool.progress` composes `${source}__${tool}` before the split, so the
			// guard has to sit after that composition, not only on the `name` shape.
			//
			// This shape is only reachable because `McpSource` emits its WIRE name.
			// It is constructed with the bare `serverName` (the registry key), so
			// before that it emitted `gmail` for a personal connector — identical to
			// the workspace source it collides with, and the guard never fired on
			// this path at all. `mcp-source-wire-name.test.ts` pins the emitter end.
			const event: EngineEvent = {
				type: "tool.progress",
				data: { source: "my_notes", tool: "append" },
			};
			expect(deriveDataChangedTarget(event)).toBeNull();
		});
	});
});

describe("deriveDataChangedTarget — the bridge door stays silent", () => {
	// A UI door's traffic is mostly READS, and a read that triggers a refresh
	// triggers a read. `files/ui` refetches on any `data.changed` for its own app
	// with no mutation filter, so broadcasting a bridge call would spin it.
	// That is the AGENTS.md rule "`/v1/tools/call` must NOT emit `data.changed`
	// (causes infinite loops)", and it is enforced HERE, by omission — which is
	// invisible, hence this test.
	test("bridge.tool.done does NOT broadcast, however successful", () => {
		const event: EngineEvent = {
			type: "bridge.tool.done",
			data: { name: "db-query__save_query", id: "c1", ok: true, ms: 4, workspaceId: WS },
		};
		expect(deriveDataChangedTarget(event)).toBeNull();
	});

	test("...and neither does bridge.tool.call", () => {
		const event: EngineEvent = {
			type: "bridge.tool.call",
			data: { name: "db-query__save_query", id: "c1", workspaceId: WS },
		};
		expect(deriveDataChangedTarget(event)).toBeNull();
	});
});

describe("deriveDataChangedTarget — which workspace changed", () => {
	test("the workspace rides along, so a listener can ignore another's change", () => {
		const event: EngineEvent = {
			type: "tool.done",
			data: { name: "db-query__save_query", ok: true, workspaceId: WS },
		};
		expect(deriveDataChangedTarget(event)?.wsId).toBe(WS);
	});

	test("an identity-door call carries no workspace, and that is an answer", () => {
		// `conversations` / `files` / `automations` belong to no workspace. Absent
		// means "everyone" — the behaviour every consumer had before the field
		// existed — not "unknown, drop it".
		const event: EngineEvent = {
			type: "tool.done",
			data: { name: "files__create", ok: true },
		};
		expect(deriveDataChangedTarget(event)).toEqual({
			server: "files",
			tool: "create",
			wsId: undefined,
		});
	});
});
