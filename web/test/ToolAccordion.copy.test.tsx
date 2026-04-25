import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ToolCallDisplay } from "../src/hooks/useChat.ts";
import { ToolAccordion } from "../src/components/ToolAccordion.tsx";

/**
 * Locks in the tool-result CopyButton's success and failure feedback.
 * The accordion section's CopyButton is shown for any tool call that has
 * resultText/errorText. Ensures we surface a "Copy failed" state when the
 * Clipboard API write rejects, instead of the previous fire-and-forget.
 */

function callWithResult(text: string): ToolCallDisplay {
	return {
		id: "t1",
		name: "search",
		status: "done",
		ok: true,
		ms: 50,
		result: {
			content: [{ type: "text", text }],
			isError: false,
		},
	};
}

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

function findCopyButton(container: HTMLElement): HTMLButtonElement {
	const btns = container.getElementsByTagName("button");
	for (const b of Array.from(btns)) {
		const cls = b.getAttribute("class") ?? "";
		if (cls.split(/\s+/).includes("tool-accordion__copy")) return b as HTMLButtonElement;
	}
	throw new Error("CopyButton not found");
}

function findHeadToggle(container: HTMLElement): HTMLButtonElement {
	const btns = container.getElementsByTagName("button");
	for (const b of Array.from(btns)) {
		const cls = b.getAttribute("class") ?? "";
		if (cls.split(/\s+/).includes("tool-accordion__head")) return b as HTMLButtonElement;
	}
	throw new Error("Head toggle not found");
}

function buttonText(btn: HTMLElement): string {
	return (btn.textContent ?? "").trim().toLowerCase();
}

function renderExpandedAccordion(text: string) {
	const result = render(
		<ToolAccordion calls={[callWithResult(text)]} displayDetail="balanced" />,
	);
	// Expand the accordion head so the result Section + CopyButton mount.
	fireEvent.click(findHeadToggle(result.container));
	return result;
}

describe("ToolAccordion CopyButton feedback", () => {
	it("shows the success state after a successful copy", async () => {
		let captured = "";
		setClipboard({
			writeText: async (t: string) => {
				captured = t;
			},
		});

		const { container } = renderExpandedAccordion("the result");

		const btn = findCopyButton(container);
		await act(async () => {
			fireEvent.click(btn);
		});

		expect(captured).toBe("the result");
		await waitFor(() => {
			expect(buttonText(btn)).toContain("copied");
		});
	});

	it("shows the failure state when writeText rejects", async () => {
		setClipboard({
			writeText: () => Promise.reject(new Error("denied")),
		});

		const { container } = renderExpandedAccordion("the result");

		const btn = findCopyButton(container);
		await act(async () => {
			fireEvent.click(btn);
		});

		await waitFor(() => {
			expect(buttonText(btn)).toContain("failed");
			expect(btn.getAttribute("aria-label")).toBe("Copy failed");
		});
	});

	it("shows the failure state when the Clipboard API is unavailable", async () => {
		setClipboard(null);

		const { container } = renderExpandedAccordion("the result");

		const btn = findCopyButton(container);
		await act(async () => {
			fireEvent.click(btn);
		});

		await waitFor(() => {
			expect(buttonText(btn)).toContain("failed");
			expect(btn.getAttribute("aria-label")).toBe("Copy failed");
		});
	});
});
