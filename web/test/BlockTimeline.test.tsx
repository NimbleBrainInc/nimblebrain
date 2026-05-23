import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { BlockTimeline } from "../src/components/BlockTimeline.tsx";
import type {
	ContentBlock,
	PreparingTool,
	StreamingState,
	ToolCallDisplay,
} from "../src/hooks/useChat.ts";

/**
 * Locks in the first-principles UX:
 *
 *   - Every block renders inline at the spot it streamed.
 *   - Per-block chips (no per-turn aggregation).
 *   - Consecutive same-name tool blocks fold into one chip with ×N.
 *   - LiveCursor covers thinking / preparing / analyzing gaps; hides
 *     when a block is actively absorbing the state.
 *   - Tool chips spin while any call is running; mute when all done.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function done(id: string, name = "search"): ToolCallDisplay {
	return { id, name, status: "done", ok: true, ms: 25 };
}
function running(id: string, name = "search"): ToolCallDisplay {
	return { id, name, status: "running" };
}
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const reasoning = (t: string): ContentBlock => ({ type: "reasoning", text: t });
const tool = (...calls: ToolCallDisplay[]): ContentBlock => ({ type: "tool", toolCalls: calls });

function renderTimeline(opts: {
	blocks: ContentBlock[];
	isCurrentMessage?: boolean;
	streamingState?: StreamingState;
	preparingTool?: PreparingTool | null;
}) {
	const {
		blocks,
		isCurrentMessage = false,
		streamingState = null,
		preparingTool = null,
	} = opts;
	return render(
		<BlockTimeline
			blocks={blocks}
			isCurrentMessage={isCurrentMessage}
			streamingState={streamingState}
			preparingTool={preparingTool}
			displayDetail="balanced"
		/>,
	);
}

/** Find all pill heads in DOM order — avoids `.turn-pill__head` selector
 *  because happy-dom rejects BEM `__` in querySelectorAll. */
function pillHeads(container: HTMLElement): HTMLButtonElement[] {
	const out: HTMLButtonElement[] = [];
	for (const b of Array.from(container.getElementsByTagName("button"))) {
		if ((b.getAttribute("class") ?? "").split(/\s+/).includes("turn-pill__head")) {
			out.push(b as HTMLButtonElement);
		}
	}
	return out;
}

function liveCursorLabel(container: HTMLElement): string | null {
	for (const el of Array.from(container.getElementsByTagName("span"))) {
		if ((el.getAttribute("class") ?? "").split(/\s+/).includes("live-cursor__label")) {
			return (el.textContent ?? "").trim();
		}
	}
	return null;
}

function timeline(container: HTMLElement): string[] {
	const out: string[] = [];
	const walker = container.ownerDocument!.createTreeWalker(
		container,
		1 /* SHOW_ELEMENT */,
		null,
	);
	let node = walker.currentNode as HTMLElement | null;
	while (node) {
		const cls = node.getAttribute?.("class") ?? "";
		const classes = cls.split(/\s+/);
		if (classes.includes("streamdown-container")) {
			const t = (node.textContent ?? "").trim();
			if (t) out.push(`text:${t}`);
		} else if (classes.includes("turn-pill__head")) {
			const t = (node.textContent ?? "").trim();
			if (t) out.push(`chip:${t}`);
		} else if (classes.includes("live-cursor")) {
			const t = (node.textContent ?? "").trim();
			if (t) out.push(`cursor:${t}`);
		}
		node = walker.nextNode() as HTMLElement | null;
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chronological rendering
// ─────────────────────────────────────────────────────────────────────────────

describe("BlockTimeline order", () => {
	it("renders blocks in stream order — text, tool, text", () => {
		// The user's reported bug: tool calls between two text spans were
		// hoisted above both. Must render inline at the spot they streamed.
		const { container } = renderTimeline({
			blocks: [
				text("Let me find the file."),
				tool(done("a", "list")),
				text("Got both."),
			],
		});
		const order = timeline(container);
		const firstText = order.findIndex((s) => s.startsWith("text:Let me find"));
		const chip = order.findIndex((s) => s.startsWith("chip:"));
		const secondText = order.findIndex((s) => s.startsWith("text:Got both"));
		expect(firstText).toBeGreaterThanOrEqual(0);
		expect(chip).toBeGreaterThan(firstText);
		expect(secondText).toBeGreaterThan(chip);
	});

	it("emits one chip per reasoning block", () => {
		// Two reasoning blocks with a text between them must surface as two
		// separate Thought chips, not collapse into one.
		const { container } = renderTimeline({
			blocks: [reasoning("first"), text("midway"), reasoning("second")],
		});
		expect(pillHeads(container).length).toBe(2);
	});

	it("skips empty (zero-token) reasoning blocks", () => {
		const { container } = renderTimeline({
			blocks: [reasoning(""), text("hi")],
		});
		expect(pillHeads(container).length).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tool-chip folding
// ─────────────────────────────────────────────────────────────────────────────

describe("BlockTimeline phase folding", () => {
	it("folds contiguous reasoning + tool blocks into ONE chip per phase", () => {
		// The user's reported pain: [Thought · 25 tokens] and [Used tools ×4]
		// as two separate chips. They are the same phase of work — one chip
		// with the reasoning + tool rows inside.
		const { container } = renderTimeline({
			blocks: [reasoning("plan"), tool(done("a", "search"), done("b", "search"))],
		});
		expect(pillHeads(container).length).toBe(1);
	});

	it("breaks the phase at a text boundary", () => {
		// Text between the two tool calls makes them distinct phases.
		const { container } = renderTimeline({
			blocks: [tool(done("a", "search")), text("midway"), tool(done("b", "search"))],
		});
		expect(pillHeads(container).length).toBe(2);
	});

	it("does NOT break the phase at a reasoning boundary", () => {
		// Reasoning is part of the phase, not a separator. [tool, reasoning,
		// tool] is ONE chip whose body lists the rows in order.
		const { container } = renderTimeline({
			blocks: [tool(done("a", "search")), reasoning("more"), tool(done("b", "search"))],
		});
		expect(pillHeads(container).length).toBe(1);
	});

	it("folds same-name consecutive tool blocks into one row with ×N", () => {
		// Within a phase, three consecutive same-name tool blocks collapse to
		// one row showing ×3. Visible in the chip's collapsed head label.
		const { container } = renderTimeline({
			blocks: [tool(done("a", "search")), tool(done("b", "search")), tool(done("c", "search"))],
		});
		const heads = pillHeads(container);
		expect(heads.length).toBe(1);
		expect(heads[0].textContent ?? "").toContain("×3");
	});

	it("keeps distinct tool names as separate rows within the same chip", () => {
		// Two consecutive tool blocks with different names share one phase
		// chip but render as two rows inside (revealed on expand).
		const { container } = renderTimeline({
			blocks: [tool(done("a", "search")), tool(done("b", "read"))],
		});
		expect(pillHeads(container).length).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Active vs settled tone
// ─────────────────────────────────────────────────────────────────────────────

describe("BlockTimeline tool tone", () => {
	function pillTones(container: HTMLElement): string[] {
		const out: string[] = [];
		for (const el of Array.from(container.getElementsByTagName("div"))) {
			if ((el.getAttribute("class") ?? "").split(/\s+/).includes("turn-pill")) {
				const tone = el.getAttribute("data-tone");
				if (tone) out.push(tone);
			}
		}
		return out;
	}

	it("spins (running tone) while any call is in flight", () => {
		const { container } = renderTimeline({
			blocks: [tool(running("a", "search"))],
			isCurrentMessage: true,
			streamingState: "working",
		});
		expect(pillTones(container)).toContain("running");
	});

	it("settles to muted (ok) tone when all calls complete", () => {
		const { container } = renderTimeline({
			blocks: [tool(done("a", "search"))],
			isCurrentMessage: false,
			streamingState: null,
		});
		const tones = pillTones(container);
		expect(tones).toContain("ok");
		expect(tones).not.toContain("running");
	});

	it("shows an error chip when a call failed", () => {
		const errorCall: ToolCallDisplay = {
			id: "err",
			name: "search",
			status: "error",
			ok: false,
			ms: 5,
		};
		const { container } = renderTimeline({
			blocks: [tool(errorCall)],
		});
		expect(pillTones(container)).toContain("error");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// LiveCursor — the gap indicator
// ─────────────────────────────────────────────────────────────────────────────

describe("LiveCursor", () => {
	it("shows 'Thinking…' for the pre-first-block warm-up", () => {
		const { container } = renderTimeline({
			blocks: [],
			isCurrentMessage: true,
			streamingState: "thinking",
		});
		expect(liveCursorLabel(container)).toBe("Thinking…");
	});

	it("shows 'Calling X…' during preparing with a known tool", () => {
		const { container } = renderTimeline({
			blocks: [],
			isCurrentMessage: true,
			streamingState: "preparing",
			preparingTool: { id: "p1", name: "synapse-research__start_research" },
		});
		// stripServerPrefix collapses `synapse-research__start_research` →
		// `start_research`.
		expect(liveCursorLabel(container)).toBe("Calling start_research…");
	});

	it("shows 'Analyzing…' between a tool result and the next block", () => {
		const { container } = renderTimeline({
			blocks: [tool(done("a", "search"))],
			isCurrentMessage: true,
			streamingState: "analyzing",
		});
		expect(liveCursorLabel(container)).toBe("Analyzing…");
	});

	it("hides during 'streaming' (text/reasoning block is absorbing the state)", () => {
		const { container } = renderTimeline({
			blocks: [text("hello")],
			isCurrentMessage: true,
			streamingState: "streaming",
		});
		expect(liveCursorLabel(container)).toBeNull();
	});

	it("hides during 'working' (tool chip is spinning)", () => {
		const { container } = renderTimeline({
			blocks: [tool(running("r", "search"))],
			isCurrentMessage: true,
			streamingState: "working",
		});
		expect(liveCursorLabel(container)).toBeNull();
	});

	it("hides when the message is not the current streaming one", () => {
		// Historical message — no live cursor regardless of state.
		const { container } = renderTimeline({
			blocks: [reasoning("done thinking"), text("done")],
			isCurrentMessage: false,
			streamingState: null,
		});
		expect(liveCursorLabel(container)).toBeNull();
	});

	it("hides when the turn is fully done (null state)", () => {
		const { container } = renderTimeline({
			blocks: [text("complete")],
			isCurrentMessage: true,
			streamingState: null,
		});
		expect(liveCursorLabel(container)).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning chip — settled persistence
// ─────────────────────────────────────────────────────────────────────────────

describe("ReasoningChip", () => {
	it("persists as a clickable 'Thought' chip on settled turns", () => {
		// Previously the only-reasoning case (no tools) hid entirely after
		// streaming. Now it stays as a clickable Thought chip so the user
		// can investigate.
		const { container } = renderTimeline({
			blocks: [reasoning("plan"), text("answer")],
			isCurrentMessage: false,
			streamingState: null,
		});
		const heads = pillHeads(container);
		expect(heads.length).toBe(1);
		expect((heads[0].textContent ?? "")).toContain("Thought");
	});

	it("shows 'Thinking…' while still receiving deltas", () => {
		const { container } = renderTimeline({
			blocks: [reasoning("partial")],
			isCurrentMessage: true,
			streamingState: "streaming",
		});
		const heads = pillHeads(container);
		expect(heads.length).toBe(1);
		expect((heads[0].textContent ?? "")).toContain("Thinking…");
	});
});
