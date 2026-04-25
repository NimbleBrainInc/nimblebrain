import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import type { ChatMessage } from "../src/hooks/useChat.ts";
import { MessageList } from "../src/components/MessageList.tsx";

/**
 * Locks in the message-level copy button's success and failure feedback.
 * Issue #81 was about Streamdown's per-block buttons (fixed via CSS), but
 * the same PR added try/catch + AlertCircle feedback to the custom copy
 * button — easy to silently regress if someone ever drops the await or
 * the failure-state branch. This test fails noisily if either happens.
 */

const assistantMsg: ChatMessage = {
	role: "assistant",
	content: "hello world",
};

let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
	originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
});

afterEach(() => {
	if (originalClipboard) {
		Object.defineProperty(globalThis.navigator, "clipboard", originalClipboard);
	} else {
		// happy-dom's navigator may not have clipboard by default; remove what we set
		// biome-ignore lint/performance/noDelete: cleanup of test mock
		delete (globalThis.navigator as { clipboard?: unknown }).clipboard;
	}
});

function findCopyButton(container: HTMLElement): HTMLButtonElement {
	const btns = container.getElementsByTagName("button");
	for (const b of Array.from(btns)) {
		const label = b.getAttribute("aria-label");
		if (label === "Copy message" || label === "Copy failed") return b as HTMLButtonElement;
	}
	throw new Error("CopyButton not found");
}

function hasIcon(container: HTMLElement, className: string): boolean {
	const svgs = container.getElementsByTagName("svg");
	for (const svg of Array.from(svgs)) {
		if ((svg.getAttribute("class") ?? "").split(/\s+/).includes(className)) return true;
	}
	return false;
}

function setClipboard(impl: { writeText: (text: string) => Promise<void> } | null) {
	Object.defineProperty(globalThis.navigator, "clipboard", {
		value: impl,
		configurable: true,
		writable: true,
	});
}

describe("MessageList CopyButton feedback", () => {
	it("shows the success state after a successful copy", async () => {
		let captured = "";
		setClipboard({
			writeText: async (text: string) => {
				captured = text;
			},
		});

		const { container } = render(
			<MessageList
				messages={[assistantMsg]}
				isStreaming={false}
				streamingState="idle"
				displayDetail="balanced"
			/>,
		);

		const btn = findCopyButton(container);
		await act(async () => {
			fireEvent.click(btn);
		});

		expect(captured).toBe("hello world");
		// Success path renders the Check icon (lucide-react adds class "lucide-check").
		await waitFor(() => {
			expect(hasIcon(container, "lucide-check")).toBe(true);
		});
	});

	it("shows the failure state when writeText rejects", async () => {
		setClipboard({
			writeText: async () => {
				throw new Error("denied");
			},
		});

		const { container } = render(
			<MessageList
				messages={[assistantMsg]}
				isStreaming={false}
				streamingState="idle"
				displayDetail="balanced"
			/>,
		);

		const btn = findCopyButton(container);
		await act(async () => {
			fireEvent.click(btn);
		});

		await waitFor(() => {
			// Failure path renders the AlertCircle icon and updates aria-label.
			expect(hasIcon(container, "lucide-circle-alert")).toBe(true);
			expect(btn.getAttribute("aria-label")).toBe("Copy failed");
		});
	});

	it("shows the failure state when the Clipboard API is unavailable", async () => {
		setClipboard(null);

		const { container } = render(
			<MessageList
				messages={[assistantMsg]}
				isStreaming={false}
				streamingState="idle"
				displayDetail="balanced"
			/>,
		);

		const btn = findCopyButton(container);
		await act(async () => {
			fireEvent.click(btn);
		});

		await waitFor(() => {
			expect(hasIcon(container, "lucide-circle-alert")).toBe(true);
			expect(btn.getAttribute("aria-label")).toBe("Copy failed");
		});
	});
});
