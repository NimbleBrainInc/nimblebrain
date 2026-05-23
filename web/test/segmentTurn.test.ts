import { describe, expect, it } from "bun:test";
import type { ContentBlock, ToolCallDisplay } from "../src/hooks/useChat.ts";
import { segmentTurn } from "../src/lib/tool-display/turn.ts";

function done(id: string, name = "search"): ToolCallDisplay {
	return { id, name, status: "done", ok: true, ms: 10 };
}
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const reasoning = (t: string): ContentBlock => ({ type: "reasoning", text: t });
const tool = (...calls: ToolCallDisplay[]): ContentBlock => ({ type: "tool", toolCalls: calls });

describe("segmentTurn", () => {
	it("returns an empty list for an empty block stream", () => {
		expect(segmentTurn([])).toEqual([]);
	});

	it("drops zero-length text blocks (streaming artifacts)", () => {
		expect(segmentTurn([text("")])).toEqual([]);
		expect(segmentTurn([text(""), tool(done("a"))])).toEqual([
			{ kind: "activity", blocks: [tool(done("a"))] },
		]);
	});

	it("keeps a single text block as its own slice", () => {
		expect(segmentTurn([text("hello")])).toEqual([{ kind: "text", text: "hello" }]);
	});

	it("groups a contiguous run of reasoning + tool blocks into one activity slice", () => {
		const blocks = [reasoning("plan"), tool(done("a")), reasoning("more"), tool(done("b"))];
		expect(segmentTurn(blocks)).toEqual([{ kind: "activity", blocks }]);
	});

	it("splits at each text boundary, preserving chronological order", () => {
		// The user's reported scenario: text → tools → text. The middle activity
		// must NOT be hoisted above either text segment.
		const segments = segmentTurn([
			text("Let me find the file."),
			reasoning("scan"),
			tool(done("a", "list")),
			tool(done("b", "read")),
			text("Got both."),
		]);
		expect(segments).toEqual([
			{ kind: "text", text: "Let me find the file." },
			{
				kind: "activity",
				blocks: [reasoning("scan"), tool(done("a", "list")), tool(done("b", "read"))],
			},
			{ kind: "text", text: "Got both." },
		]);
	});

	it("handles activity → text → activity (model resumes thinking after text)", () => {
		const segments = segmentTurn([
			reasoning("a"),
			tool(done("1")),
			text("first answer"),
			reasoning("b"),
			tool(done("2")),
		]);
		expect(segments).toEqual([
			{ kind: "activity", blocks: [reasoning("a"), tool(done("1"))] },
			{ kind: "text", text: "first answer" },
			{ kind: "activity", blocks: [reasoning("b"), tool(done("2"))] },
		]);
	});

	it("emits an activity slice for trailing non-text blocks (no flush dropped)", () => {
		const segments = segmentTurn([text("preamble"), tool(done("a"))]);
		expect(segments).toEqual([
			{ kind: "text", text: "preamble" },
			{ kind: "activity", blocks: [tool(done("a"))] },
		]);
	});

	it("does not merge tool calls across a text boundary (segmentation comes before grouping)", () => {
		// A tool used both before and after a text block reads as two separate
		// phases of work. groupTurn folds same-named calls *within* a slice;
		// segmentation must not silently re-merge across slices.
		const segments = segmentTurn([
			tool(done("a", "search")),
			text("midway"),
			tool(done("b", "search")),
		]);
		expect(segments).toHaveLength(3);
		expect(segments[0]).toEqual({ kind: "activity", blocks: [tool(done("a", "search"))] });
		expect(segments[2]).toEqual({ kind: "activity", blocks: [tool(done("b", "search"))] });
	});
});
