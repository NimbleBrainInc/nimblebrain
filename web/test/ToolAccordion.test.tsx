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
});
