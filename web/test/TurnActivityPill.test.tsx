import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { TurnActivityPill } from "../src/components/TurnActivityPill.tsx";
import type { ContentBlock, PreparingTool, ToolCallDisplay } from "../src/hooks/useChat.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function doneCall(id: string, name = "search", ms = 50): ToolCallDisplay {
	return { id, name, status: "done", ok: true, ms };
}

function failedCall(id: string, name = "search", ms = 5): ToolCallDisplay {
	return { id, name, status: "error", ok: false, ms };
}

function runningCall(id: string, name = "search"): ToolCallDisplay {
	return { id, name, status: "running" };
}

function toolBlock(...calls: ToolCallDisplay[]): ContentBlock {
	return { type: "tool", toolCalls: calls };
}

function reasoningBlock(text: string): ContentBlock {
	return { type: "reasoning", text };
}

const PILL_TONE_RE = /class="turn-pill"[^>]*data-tone="([^"]+)"/;
function pillTone(html: string): string | null {
	const m = html.match(PILL_TONE_RE);
	return m ? (m[1] ?? null) : null;
}
function countSpinners(html: string): number {
	return (html.match(/turn-pill__icon--running/g) ?? []).length;
}
function findHead(container: HTMLElement): HTMLButtonElement {
	const btns = container.getElementsByTagName("button");
	for (const b of Array.from(btns)) {
		if ((b.getAttribute("class") ?? "").split(/\s+/).includes("turn-pill__head")) {
			return b as HTMLButtonElement;
		}
	}
	throw new Error("Pill head not found");
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-block grouping — the Mercury repro
// ─────────────────────────────────────────────────────────────────────────────

describe("TurnActivityPill cross-block grouping", () => {
	// The whole point of the redesign: 30 single-call blocks broken up by
	// reasoning would previously render as 30 mini-accordions. The new pill
	// folds them into one entry per tool name, regardless of interleaving.
	it("collapses N consecutive single-call blocks of the same tool into one row", () => {
		const blocks: ContentBlock[] = [
			reasoningBlock("plan"),
			toolBlock(doneCall("a", "list_transactions", 100)),
			toolBlock(doneCall("b", "list_transactions", 200)),
			toolBlock(doneCall("c", "list_transactions", 150)),
		];
		const { container } = render(
			<TurnActivityPill
				blocks={blocks}
				streamingState={null}
				preparingTool={null}
				isCurrentTurn={false}
				displayDetail="balanced"
			/>,
		);
		fireEvent.click(findHead(container));
		// One tool-group row containing all three calls; row-count multiplier reads ×3.
		const rowHeads = Array.from(container.getElementsByTagName("button")).filter((b) =>
			(b.getAttribute("class") ?? "").split(/\s+/).includes("turn-pill__row-head"),
		);
		// rows: 1 reasoning + 1 tool group = 2 row heads
		expect(rowHeads.length).toBe(2);
		expect(container.innerHTML).toContain("×3");
	});

	it("merges across reasoning interleaving (Mercury pattern)", () => {
		const blocks: ContentBlock[] = [
			reasoningBlock("first thought"),
			toolBlock(doneCall("a", "list_transactions", 100)),
			reasoningBlock("interrupting thought"),
			toolBlock(doneCall("b", "list_transactions", 100)),
			reasoningBlock("another"),
			toolBlock(doneCall("c", "list_transactions", 100)),
		];
		const { container } = render(
			<TurnActivityPill
				blocks={blocks}
				streamingState={null}
				preparingTool={null}
				isCurrentTurn={false}
				displayDetail="balanced"
			/>,
		);
		fireEvent.click(findHead(container));
		// One ×3 group despite reasoning splitting the blocks apart.
		expect(container.innerHTML).toContain("×3");
	});

	it("keeps distinct tool names in separate groups", () => {
		const blocks: ContentBlock[] = [
			toolBlock(doneCall("a", "list_transactions")),
			toolBlock(doneCall("b", "get_recipients")),
			toolBlock(doneCall("c", "list_transactions")),
		];
		const { container } = render(
			<TurnActivityPill
				blocks={blocks}
				streamingState={null}
				preparingTool={null}
				isCurrentTurn={false}
				displayDetail="balanced"
			/>,
		);
		fireEvent.click(findHead(container));
		const html = container.innerHTML;
		// Two groups: list_transactions ×2 and get_recipients ×1 (no multiplier shown for 1).
		expect(html).toContain("×2");
		expect(html).toContain("recipients");
		expect(html).toContain("transactions");
	});

	it("does not collide same-named tools from different servers", () => {
		// Two servers each expose a `search` tool. They must render as separate
		// rows; folding them into one "Searched ×2" would misrepresent which
		// server did what work.
		const blocks: ContentBlock[] = [
			toolBlock(doneCall("a", "notion__search")),
			toolBlock(doneCall("b", "mercury__search")),
			toolBlock(doneCall("c", "notion__search")),
		];
		const { container } = render(
			<TurnActivityPill
				blocks={blocks}
				streamingState={null}
				preparingTool={null}
				isCurrentTurn={false}
				displayDetail="balanced"
			/>,
		);
		fireEvent.click(findHead(container));
		const rowHeads = Array.from(container.getElementsByTagName("button")).filter((b) =>
			(b.getAttribute("class") ?? "").split(/\s+/).includes("turn-pill__row-head"),
		);
		// Exactly two tool-group rows — notion ×2 and mercury ×1.
		expect(rowHeads.length).toBe(2);
		expect(container.innerHTML).toContain("×2");
	});

	it("counts total steps at the head across all groups", () => {
		const blocks: ContentBlock[] = [
			toolBlock(doneCall("a", "list_transactions")),
			toolBlock(doneCall("b", "list_transactions")),
			toolBlock(doneCall("c", "get_recipients")),
		];
		const { container } = render(
			<TurnActivityPill
				blocks={blocks}
				streamingState={null}
				preparingTool={null}
				isCurrentTurn={false}
				displayDetail="balanced"
			/>,
		);
		expect(container.innerHTML).toContain("3 steps");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Head morphing across streamingState
// ─────────────────────────────────────────────────────────────────────────────

describe("TurnActivityPill head label", () => {
	it("shows 'Calling X…' during preparing on the current turn", () => {
		const preparing: PreparingTool = { id: "p1", name: "server__search_thing" };
		const { container } = render(
			<TurnActivityPill
				blocks={[]}
				streamingState="preparing"
				preparingTool={preparing}
				isCurrentTurn={true}
				displayDetail="balanced"
			/>,
		);
		expect(container.innerHTML).toContain("Calling search_thing");
		expect(pillTone(container.innerHTML)).toBe("running");
	});

	it("shows 'Analyzing…' during analyzing on the current turn", () => {
		const { container } = render(
			<TurnActivityPill
				blocks={[toolBlock(doneCall("a", "search"))]}
				streamingState="analyzing"
				preparingTool={null}
				isCurrentTurn={true}
				displayDetail="balanced"
			/>,
		);
		expect(container.innerHTML).toContain("Analyzing");
		expect(pillTone(container.innerHTML)).toBe("running");
	});

	it("settles to past tense + duration when streaming completes", () => {
		const { container } = render(
			<TurnActivityPill
				blocks={[toolBlock(doneCall("a", "list_transactions", 1500))]}
				streamingState={null}
				preparingTool={null}
				isCurrentTurn={false}
				displayDetail="balanced"
			/>,
		);
		const html = container.innerHTML;
		// Past tense ("Listed"), step count, and total duration all visible at rest.
		expect(html).toMatch(/Listed/);
		expect(html).toContain("1 step");
		expect(html).toContain("1.5s");
		expect(pillTone(html)).toBe("neutral");
	});

	it("hides entirely when no tools were called and no leading state is live", () => {
		const { container } = render(
			<TurnActivityPill
				blocks={[]}
				streamingState={null}
				preparingTool={null}
				isCurrentTurn={false}
				displayDetail="balanced"
			/>,
		);
		expect(container.innerHTML).toBe("");
	});

	it("hides entirely in quiet mode regardless of streamingState", () => {
		const { container } = render(
			<TurnActivityPill
				blocks={[toolBlock(doneCall("a"))]}
				streamingState="analyzing"
				preparingTool={null}
				isCurrentTurn={true}
				displayDetail="quiet"
			/>,
		);
		expect(container.innerHTML).toBe("");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Single-spinner contract — never two indicators on screen
// ─────────────────────────────────────────────────────────────────────────────

describe("TurnActivityPill single-spinner contract", () => {
	it("renders exactly one spinner when tools are in flight (no body open)", () => {
		const { container } = render(
			<TurnActivityPill
				blocks={[toolBlock(runningCall("a", "search"))]}
				streamingState="working"
				preparingTool={null}
				isCurrentTurn={true}
				displayDetail="balanced"
			/>,
		);
		expect(countSpinners(container.innerHTML)).toBe(1);
	});

	it("does not emit a separate 'Analyzing' indicator alongside the head", () => {
		// Pre-redesign, the accordion head + a pending footer + the composer
		// label could all say 'Analyzing' at once. The new pill must own the
		// state entirely on a single element.
		const { container } = render(
			<TurnActivityPill
				blocks={[toolBlock(doneCall("a", "search"))]}
				streamingState="analyzing"
				preparingTool={null}
				isCurrentTurn={true}
				displayDetail="balanced"
			/>,
		);
		// Exactly one occurrence of "Analyzing" — on the head only.
		expect((container.innerHTML.match(/Analyzing/g) ?? []).length).toBe(1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Tone policy — head stays neutral when a child fails
// ─────────────────────────────────────────────────────────────────────────────

describe("TurnActivityPill tone policy", () => {
	it("stays neutral when a child call failed", () => {
		const { container } = render(
			<TurnActivityPill
				blocks={[toolBlock(doneCall("a", "list_documents"), failedCall("b", "get_doc"))]}
				streamingState={null}
				preparingTool={null}
				isCurrentTurn={false}
				displayDetail="balanced"
			/>,
		);
		expect(pillTone(container.innerHTML)).toBe("neutral");
		expect(container.innerHTML).not.toContain("Couldn't");
	});

	it("shows red per-call icon for the failed child when expanded", () => {
		const { container } = render(
			<TurnActivityPill
				blocks={[toolBlock(doneCall("a", "list_documents"), failedCall("b", "list_documents"))]}
				streamingState={null}
				preparingTool={null}
				isCurrentTurn={false}
				displayDetail="balanced"
			/>,
		);
		fireEvent.click(findHead(container));
		expect(container.innerHTML).toContain("turn-pill__icon--error");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning row
// ─────────────────────────────────────────────────────────────────────────────

describe("TurnActivityPill reasoning row", () => {
	it("shows 'Thought · N tokens' as a row in L2 timeline", () => {
		const { container } = render(
			<TurnActivityPill
				blocks={[
					reasoningBlock("Thinking about how to answer this question carefully"),
					toolBlock(doneCall("a", "search")),
				]}
				streamingState={null}
				preparingTool={null}
				isCurrentTurn={false}
				displayDetail="balanced"
			/>,
		);
		fireEvent.click(findHead(container));
		const html = container.innerHTML;
		expect(html).toContain("Thought");
		expect(html).toMatch(/\d+\s+tokens/);
	});

	it("skips empty reasoning blocks (no row for a 0-token entry)", () => {
		const { container } = render(
			<TurnActivityPill
				blocks={[reasoningBlock(""), toolBlock(doneCall("a", "search"))]}
				streamingState={null}
				preparingTool={null}
				isCurrentTurn={false}
				displayDetail="balanced"
			/>,
		);
		fireEvent.click(findHead(container));
		expect(container.innerHTML).not.toContain("Thought");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// CopyButton feedback (preserves the behavior from the deleted tests)
// ─────────────────────────────────────────────────────────────────────────────

let originalClipboard: PropertyDescriptor | undefined;
beforeEach(() => {
	originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
});
afterEach(() => {
	if (originalClipboard) {
		Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
	} else {
		// biome-ignore lint/performance/noDelete: cleanup of test mock
		delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
	}
});
function setClipboard(impl: { writeText: (text: string) => Promise<void> } | null) {
	Object.defineProperty(globalThis.navigator, "clipboard", {
		value: impl,
		configurable: true,
		writable: true,
	});
}

function callWithResult(text: string): ToolCallDisplay {
	return {
		id: "t1",
		name: "search",
		status: "done",
		ok: true,
		ms: 50,
		result: { content: [{ type: "text", text }], isError: false },
	};
}
function findCopyButton(container: HTMLElement): HTMLButtonElement {
	const btns = container.getElementsByTagName("button");
	for (const b of Array.from(btns)) {
		if ((b.getAttribute("class") ?? "").split(/\s+/).includes("turn-pill__copy")) {
			return b as HTMLButtonElement;
		}
	}
	throw new Error("CopyButton not found");
}
function findRowHead(container: HTMLElement): HTMLButtonElement {
	const btns = container.getElementsByTagName("button");
	for (const b of Array.from(btns)) {
		if ((b.getAttribute("class") ?? "").split(/\s+/).includes("turn-pill__row-head")) {
			return b as HTMLButtonElement;
		}
	}
	throw new Error("Row head not found");
}

function renderExpanded(text: string) {
	const result = render(
		<TurnActivityPill
			blocks={[toolBlock(callWithResult(text))]}
			streamingState={null}
			preparingTool={null}
			isCurrentTurn={false}
			displayDetail="balanced"
		/>,
	);
	// Expand head → row.
	fireEvent.click(findHead(result.container));
	fireEvent.click(findRowHead(result.container));
	return result;
}

describe("TurnActivityPill CopyButton feedback", () => {
	it("shows success after a successful copy", async () => {
		let captured = "";
		setClipboard({ writeText: async (t) => void (captured = t) });
		const { container } = renderExpanded("the result");
		const btn = findCopyButton(container);
		await act(async () => {
			fireEvent.click(btn);
		});
		expect(captured).toBe("the result");
		await waitFor(() => {
			expect((btn.textContent ?? "").toLowerCase()).toContain("copied");
		});
	});

	it("shows failure when writeText rejects", async () => {
		setClipboard({ writeText: () => Promise.reject(new Error("denied")) });
		const { container } = renderExpanded("the result");
		const btn = findCopyButton(container);
		await act(async () => {
			fireEvent.click(btn);
		});
		await waitFor(() => {
			expect((btn.textContent ?? "").toLowerCase()).toContain("failed");
			expect(btn.getAttribute("aria-label")).toBe("Copy failed");
		});
	});

	it("shows failure when the Clipboard API is unavailable", async () => {
		setClipboard(null);
		const { container } = renderExpanded("the result");
		const btn = findCopyButton(container);
		await act(async () => {
			fireEvent.click(btn);
		});
		await waitFor(() => {
			expect((btn.textContent ?? "").toLowerCase()).toContain("failed");
			expect(btn.getAttribute("aria-label")).toBe("Copy failed");
		});
	});
});
