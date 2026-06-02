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
});
