import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import type { ToolCallDisplay } from "../src/hooks/useChat.ts";
import { ToolAccordion } from "../src/components/ToolAccordion.tsx";

function doneCall(id: string, name = "search"): ToolCallDisplay {
	return {
		id,
		name,
		status: "done",
		ok: true,
		ms: 120,
	};
}

function failedCall(id: string, name = "search"): ToolCallDisplay {
	return {
		id,
		name,
		status: "error",
		ok: false,
		ms: 5,
	};
}

function runningCall(id: string, name = "search"): ToolCallDisplay {
	return { id, name, status: "running" };
}

function hasPendingFooter(html: string): boolean {
	return html.includes("tool-accordion__pending");
}

describe("ToolAccordion pending footer", () => {
	it("does not render the Analyzing row when pending is false", () => {
		const { container } = render(
			<ToolAccordion calls={[doneCall("t1")]} displayDetail="balanced" pending={false} />,
		);
		expect(hasPendingFooter(container.innerHTML)).toBe(false);
	});

	it("renders the Analyzing row when pending is true", () => {
		const { container } = render(
			<ToolAccordion calls={[doneCall("t1")]} displayDetail="balanced" pending={true} />,
		);
		expect(hasPendingFooter(container.innerHTML)).toBe(true);
		expect(container.innerHTML).toContain("Analyzing");
	});

	it("does not render the accordion at all (including pending) in quiet mode", () => {
		const { container } = render(
			<ToolAccordion calls={[doneCall("t1")]} displayDetail="quiet" pending={true} />,
		);
		// In quiet mode the whole accordion is suppressed; the composer carries the signal.
		expect(container.innerHTML).toBe("");
	});

	// Regression guard for the useMinDisplayTime overlap: while any call is
	// still visually running (either actually running or inside the 600ms
	// smoothing window), the pending footer must stay hidden to avoid two
	// spinners with conflicting copy on screen simultaneously.
	it("suppresses the Analyzing row while any call is visually running", () => {
		const { container } = render(
			<ToolAccordion calls={[runningCall("t1")]} displayDetail="balanced" pending={true} />,
		);
		expect(hasPendingFooter(container.innerHTML)).toBe(false);
	});
});

// Regression guard: the batch header is not a status reducer. A failed
// child must NOT escalate the head to an error tone; per-call rows carry
// their own per-call truth, and turn-level failures live at the message
// level (msg.error / msg.stopReason in MessageList).
//
// Note: container.querySelector hits a happy-dom bug in this test runner
// (this.window.SyntaxError is undefined). Match the rest of the file and
// assert against the rendered HTML string instead.
const HEAD_DATA_TONE_RE = /class="tool-accordion"[^>]*data-tone="([^"]+)"/;

function headTone(html: string): string | null {
	const match = html.match(HEAD_DATA_TONE_RE);
	return match ? (match[1] ?? null) : null;
}

describe("ToolAccordion batch header (neutral semantics)", () => {
	it("renders neutral header when a child call failed", () => {
		const { container } = render(
			<ToolAccordion
				calls={[doneCall("t1", "list_documents"), failedCall("t2", "get_doc")]}
				displayDetail="balanced"
			/>,
		);
		expect(headTone(container.innerHTML)).toBe("neutral");
		// Verb phrase narrates what was attempted; never "Couldn't X" at the head.
		expect(container.innerHTML).not.toContain("Couldn't");
	});

	it("renders neutral header when every child failed", () => {
		const { container } = render(
			<ToolAccordion
				calls={[failedCall("t1", "list_documents"), failedCall("t2", "list_documents")]}
				displayDetail="balanced"
			/>,
		);
		expect(headTone(container.innerHTML)).toBe("neutral");
		expect(container.innerHTML).not.toContain("Couldn't");
	});

	it("renders running header when any child is running", () => {
		const { container } = render(
			<ToolAccordion
				calls={[failedCall("t1", "list_documents"), runningCall("t2", "list_documents")]}
				displayDetail="balanced"
			/>,
		);
		expect(headTone(container.innerHTML)).toBe("running");
	});
});
