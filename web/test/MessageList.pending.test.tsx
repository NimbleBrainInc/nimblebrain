import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import type { ChatMessage, ToolCallDisplay } from "../src/hooks/useChat.ts";
import { MessageList } from "../src/components/MessageList.tsx";

function doneCall(id: string): ToolCallDisplay {
	return { id, name: "search", status: "done", ok: true, ms: 50 };
}

function countPendingFooters(html: string): number {
	return (html.match(/tool-accordion__pending/g) ?? []).length;
}

/**
 * Regression guard for the pending-prop indexing in MessageList:
 *
 *   pending = streamingState === "analyzing"
 *          && idx       === messages.length - 1      // latest message
 *          && blockIdx  === msg.blocks.length - 1    // latest block in that message
 *
 * An off-by-one or a dropped conjunct would show the "Analyzing…" indicator
 * on the wrong tool block (or on every tool block in the turn), which is
 * easy to miss in manual QA.
 */
describe("MessageList pending indexing", () => {
	const user: ChatMessage = {
		role: "user",
		content: "go",
	};

	const assistantWithTwoToolBlocks: ChatMessage = {
		role: "assistant",
		content: "",
		blocks: [
			{ type: "tool", toolCalls: [doneCall("a1")] },
			{ type: "text", text: "thinking about that" },
			{ type: "tool", toolCalls: [doneCall("b1")] },
		],
	};

	it("renders the Analyzing footer only on the last tool block when analyzing", () => {
		const { container } = render(
			<MessageList
				messages={[user, assistantWithTwoToolBlocks]}
				isStreaming={true}
				streamingState="analyzing"
				displayDetail="balanced"
			/>,
		);
		// Exactly one pending footer; no other tool block gets it.
		expect(countPendingFooters(container.innerHTML)).toBe(1);
	});

	it("does not render any Analyzing footer when not in analyzing state", () => {
		const { container } = render(
			<MessageList
				messages={[user, assistantWithTwoToolBlocks]}
				isStreaming={true}
				streamingState="working"
				displayDetail="balanced"
			/>,
		);
		expect(countPendingFooters(container.innerHTML)).toBe(0);
	});

	it("does not attach pending to a tool block that is NOT the last message", () => {
		// Two assistant turns, both with tool blocks. Only the LATEST message's
		// last block is eligible — an earlier turn's tool block must stay silent.
		const earlierAssistant: ChatMessage = {
			role: "assistant",
			content: "done",
			blocks: [{ type: "tool", toolCalls: [doneCall("x1")] }],
		};
		const { container } = render(
			<MessageList
				messages={[user, earlierAssistant, user, assistantWithTwoToolBlocks]}
				isStreaming={true}
				streamingState="analyzing"
				displayDetail="balanced"
			/>,
		);
		// Still exactly one pending footer even though there are two assistant
		// turns with tool blocks — prior turn's tool block must not get it.
		expect(countPendingFooters(container.innerHTML)).toBe(1);
	});
});
