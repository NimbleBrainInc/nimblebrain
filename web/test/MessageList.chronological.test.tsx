import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { MessageList } from "../src/components/MessageList.tsx";
import type { ChatMessage, ContentBlock, ToolCallDisplay } from "../src/hooks/useChat.ts";

/**
 * Regression test for the "thinking blocks above the last message" bug.
 *
 * The previous design hoisted a single TurnActivityPill to the top of every
 * assistant message, so a turn that streamed [text → tools → text] rendered
 * as [pill, text, text] — the pill ahead of the work it summarized.
 *
 * With segment-based rendering, each contiguous run of reasoning + tool
 * blocks gets its own pill at the spot it streamed, interleaved with text
 * slices in chronological order.
 */

function done(id: string, name = "search"): ToolCallDisplay {
	return { id, name, status: "done", ok: true, ms: 10 };
}
const text = (t: string): ContentBlock => ({ type: "text", text: t });
const tool = (...calls: ToolCallDisplay[]): ContentBlock => ({ type: "tool", toolCalls: calls });

/** Count pill heads. Avoids `.turn-pill__head` selector — happy-dom's parser
 *  rejects BEM `__` segments in `querySelectorAll`. */
function countPillHeads(container: HTMLElement): number {
	let n = 0;
	for (const b of Array.from(container.getElementsByTagName("button"))) {
		if ((b.getAttribute("class") ?? "").split(/\s+/).includes("turn-pill__head")) n++;
	}
	return n;
}

/** Pluck human-readable markers (text snippets + pill labels) in DOM order. */
function timeline(container: HTMLElement): string[] {
	const out: string[] = [];
	const walker = container.ownerDocument!.createTreeWalker(
		container,
		1 /* SHOW_ELEMENT */,
		null,
	);
	let node = walker.currentNode as HTMLElement | null;
	while (node) {
		const el = node;
		const cls = el.getAttribute("class") ?? "";
		const classes = cls.split(/\s+/);
		// Streamdown wraps prose in a container — capture once per message body.
		if (classes.includes("streamdown-container")) {
			const t = (el.textContent ?? "").trim();
			if (t) out.push(`text:${t}`);
		}
		// Pill head label is a button.turn-pill__head; its text content
		// captures the head label plus any step / duration suffix.
		if (classes.includes("turn-pill__head")) {
			const t = (el.textContent ?? "").trim();
			if (t) out.push(`pill:${t}`);
		}
		node = walker.nextNode() as HTMLElement | null;
	}
	return out;
}

describe("MessageList chronological rendering", () => {
	it("renders pills at the spot they streamed, not hoisted to the top", () => {
		const msg: ChatMessage = {
			role: "assistant",
			content: "",
			blocks: [
				text("Let me find the file and discover the research tools in parallel."),
				tool(done("a", "list"), done("b", "read")),
				text("Got both. Now I'll promote the start_research tool and then fire it off."),
			],
		};
		const { container } = render(
			<MessageList
				messages={[msg]}
				isStreaming={false}
				streamingState={null}
				displayDetail="balanced"
			/>,
		);

		const order = timeline(container);
		expect(order.length).toBeGreaterThanOrEqual(3);
		const firstText = order.findIndex((s) => s.startsWith("text:Let me find"));
		const pill = order.findIndex((s) => s.startsWith("pill:"));
		const secondText = order.findIndex((s) => s.startsWith("text:Got both"));
		expect(firstText).toBeGreaterThanOrEqual(0);
		expect(pill).toBeGreaterThan(firstText);
		expect(secondText).toBeGreaterThan(pill);
	});

	it("emits one pill per activity run when activity is split by text", () => {
		const msg: ChatMessage = {
			role: "assistant",
			content: "",
			blocks: [
				tool(done("a", "list")),
				text("first answer"),
				tool(done("b", "search")),
				text("second answer"),
			],
		};
		const { container } = render(
			<MessageList
				messages={[msg]}
				isStreaming={false}
				streamingState={null}
				displayDetail="balanced"
			/>,
		);

		expect(countPillHeads(container)).toBe(2);
	});

	it("collapses adjacent reasoning + tools into a single pill within one slice", () => {
		// Stream order [reasoning, tool, reasoning, tool] with no text between
		// must yield exactly one pill — segmentation must not over-split.
		const msg: ChatMessage = {
			role: "assistant",
			content: "",
			blocks: [
				{ type: "reasoning", text: "plan" },
				tool(done("a")),
				{ type: "reasoning", text: "more" },
				tool(done("b")),
				text("answer"),
			],
		};
		const { container } = render(
			<MessageList
				messages={[msg]}
				isStreaming={false}
				streamingState={null}
				displayDetail="balanced"
			/>,
		);

		expect(countPillHeads(container)).toBe(1);
	});
});
