import { describe, expect, it } from "bun:test";
import type { LanguageModelV3Message } from "@ai-sdk/provider";
import { sliceHistory, windowMessages } from "../../src/conversation/window.ts";

/** Helper: create a simple text message. */
function textMsg(role: "user" | "assistant", text: string): LanguageModelV3Message {
	return { role, content: [{ type: "text" as const, text }] };
}

/** Helper: create an assistant message with one or more tool-call blocks. */
function toolCallMsg(...toolCallIds: string[]): LanguageModelV3Message {
	return {
		role: "assistant",
		content: toolCallIds.map((id) => ({
			type: "tool-call" as const,
			toolCallId: id,
			toolName: "some_tool",
			input: { query: "test" },
		})),
	};
}

/** Helper: create a tool message with a tool-result block. */
function toolResultMsg(toolCallId: string, result = "ok"): LanguageModelV3Message {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result" as const,
				toolCallId,
				toolName: "some_tool",
				output: { type: "text" as const, value: result },
			},
		],
	};
}

/**
 * Assert that no tool-result message appears without a preceding
 * assistant message containing the corresponding tool-call.
 * This is the invariant that the Claude API enforces.
 */
function assertNoOrphanedToolResults(msgs: LanguageModelV3Message[]) {
	for (let i = 0; i < msgs.length; i++) {
		const msg = msgs[i]!;
		if (msg.role !== "tool") continue;
		if (!Array.isArray(msg.content)) continue;

		const hasResult = msg.content.some(
			(b) => "type" in b && b.type === "tool-result",
		);
		if (!hasResult) continue;

		// Must have a preceding assistant message with tool-call
		expect(i).toBeGreaterThan(0);
		// Walk backward to find the nearest assistant with tool-call
		let found = false;
		for (let j = i - 1; j >= 0; j--) {
			const prev = msgs[j]!;
			if (prev.role === "assistant" && Array.isArray(prev.content)) {
				const prevHasToolCall = prev.content.some(
					(b) => "type" in b && b.type === "tool-call",
				);
				if (prevHasToolCall) {
					found = true;
					break;
				}
			}
			// If we hit a user message, the tool result is orphaned
			if (prev.role === "user") break;
		}
		expect(found).toBe(true);
	}
}

describe("windowMessages", () => {
	it("returns empty for empty history", () => {
		expect(windowMessages([], 100_000)).toEqual([]);
	});

	it("returns messages unchanged when within budget", () => {
		const msgs: LanguageModelV3Message[] = [
			textMsg("user", "Hello"),
			textMsg("assistant", "Hi there"),
			textMsg("user", "How are you?"),
		];
		// These messages are tiny, well within 100k tokens
		const result = windowMessages(msgs, 100_000);
		expect(result).toEqual(msgs);
	});

	it("preserves first message and keeps recent messages that fit", () => {
		// Create 100 messages with predictable sizes
		const msgs: LanguageModelV3Message[] = [];
		for (let i = 0; i < 100; i++) {
			const role = i % 2 === 0 ? "user" : "assistant";
			// Each message ~100 chars = ~25 tokens
			msgs.push(textMsg(role as "user" | "assistant", `Message number ${i} ${"x".repeat(80)}`));
		}

		// Budget: first message (~25 tokens) + room for ~10 more messages (~250 tokens)
		const budget = 300;
		const result = windowMessages(msgs, budget);

		// First message is always preserved
		expect(result[0]).toEqual(msgs[0]);

		// Should have fewer messages than original
		expect(result.length).toBeLessThan(msgs.length);
		expect(result.length).toBeGreaterThan(1);

		// Last message of result should be the last message of input
		expect(result[result.length - 1]).toEqual(msgs[msgs.length - 1]);
	});

	it("keeps tool-call/tool-result pairs atomic — never splits them", () => {
		const msgs: LanguageModelV3Message[] = [
			textMsg("user", "Do something"),                           // 0 - first, always kept
			textMsg("assistant", "Sure, let me use a tool"),           // 1
			toolCallMsg("call_1"),                                     // 2 - tool-call
			toolResultMsg("call_1", "x".repeat(400)),                  // 3 - tool-result (large)
			textMsg("user", "Thanks"),                                 // 4
			toolCallMsg("call_2"),                                     // 5 - tool-call
			toolResultMsg("call_2", "small result"),                   // 6 - tool-result
			textMsg("user", "Final question"),                         // 7
			textMsg("assistant", "Final answer"),                      // 8
		];

		// Set budget tight enough that not everything fits but the last few do
		const budget = 120;
		const result = windowMessages(msgs, budget);

		// First message preserved
		expect(result[0]).toEqual(msgs[0]);

		// Check that no tool-result appears without its corresponding tool-call
		assertNoOrphanedToolResults(result);
	});

	it("windowed history has valid message sequence (no orphaned tool results)", () => {
		// Build a long conversation with interleaved tool calls
		const msgs: LanguageModelV3Message[] = [textMsg("user", "Start")];
		for (let i = 0; i < 20; i++) {
			const callId = `call_${i}`;
			msgs.push(toolCallMsg(callId));
			msgs.push(toolResultMsg(callId, `Result for ${i} ${"y".repeat(50)}`));
		}
		msgs.push(textMsg("user", "Done"));

		// Small budget forces heavy windowing
		const budget = 200;
		const result = windowMessages(msgs, budget);

		assertNoOrphanedToolResults(result);

		// First message always preserved
		expect(result[0]).toEqual(msgs[0]);
	});

	it("keeps parallel tool calls atomic — assistant + multiple tool results stay together", () => {
		// Reproduces the production bug: model makes 4 parallel tool calls,
		// reconstructor emits 1 assistant + 4 separate tool messages.
		// Without proper grouping, windowing can drop the assistant but keep
		// orphaned tool results, causing Claude API "unexpected tool_use_id" errors.
		const msgs: LanguageModelV3Message[] = [
			textMsg("user", "Read all the files"),
			// First round: 4 parallel tool calls
			toolCallMsg("call_a", "call_b", "call_c", "call_d"),
			toolResultMsg("call_a", "file A content " + "x".repeat(200)),
			toolResultMsg("call_b", "file B content " + "x".repeat(200)),
			toolResultMsg("call_c", "file C content " + "x".repeat(200)),
			toolResultMsg("call_d", "file D content " + "x".repeat(200)),
			// Second round: 4 more parallel tool calls
			toolCallMsg("call_e", "call_f", "call_g", "call_h"),
			toolResultMsg("call_e", "file E content " + "x".repeat(200)),
			toolResultMsg("call_f", "file F content " + "x".repeat(200)),
			toolResultMsg("call_g", "file G content " + "x".repeat(200)),
			toolResultMsg("call_h", "file H content " + "x".repeat(200)),
			// Final text response
			textMsg("assistant", "I've read all the files."),
			// Next user message
			textMsg("user", "Now take action on them"),
		];

		// Budget tight enough to force dropping the first batch
		const budget = 800;
		const result = windowMessages(msgs, budget);

		// First message always preserved
		expect(result[0]).toEqual(msgs[0]);

		// The critical invariant: no orphaned tool results
		assertNoOrphanedToolResults(result);
	});

	it("sliceHistory keeps parallel tool call groups intact", () => {
		const msgs: LanguageModelV3Message[] = [
			textMsg("user", "Start"),
			// Parallel batch 1
			toolCallMsg("a1", "a2", "a3"),
			toolResultMsg("a1"),
			toolResultMsg("a2"),
			toolResultMsg("a3"),
			// Parallel batch 2
			toolCallMsg("b1", "b2"),
			toolResultMsg("b1"),
			toolResultMsg("b2"),
			textMsg("assistant", "Done"),
			textMsg("user", "Next"),
		];

		// Keep only 2 groups — should keep batch 2 + "Done" + "Next"
		// but NOT split batch 1 leaving orphaned results
		const result = sliceHistory(msgs, 3);

		expect(result[0]).toEqual(msgs[0]);
		assertNoOrphanedToolResults(result);
	});

	it("handles structured content token estimation correctly", () => {
		const structuredMsg: LanguageModelV3Message = {
			role: "tool",
			content: [
				{
					type: "tool-result" as const,
					toolCallId: "call_1",
					toolName: "some_tool",
					output: { type: "text" as const, value: JSON.stringify({ data: "x".repeat(1000) }) },
				},
			],
		};

		// With a budget smaller than this message, windowing should drop it
		// Note: the tool-result is paired with a tool-call assistant message
		const assistantMsg = toolCallMsg("call_1");
		const msgs: LanguageModelV3Message[] = [
			textMsg("user", "Hi"),
			assistantMsg,
			structuredMsg,
			textMsg("assistant", "Done"),
		];

		// Budget that fits first + last but not the big tool call pair
		const budget = 30;
		const result = windowMessages(msgs, budget);
		expect(result[0]).toEqual(msgs[0]);
		// The structured message should be dropped (too large)
		const hasStructured = result.some((m) => m === structuredMsg);
		expect(hasStructured).toBe(false);
		// And the tool-call assistant should also be dropped (atomic pair)
		const hasToolCall = result.some((m) => m === assistantMsg);
		expect(hasToolCall).toBe(false);
	});

	it("returns all messages when exactly at budget", () => {
		const msgs: LanguageModelV3Message[] = [
			textMsg("user", "Hello"),       // 5 chars / 4 = 2 tokens
			textMsg("assistant", "World"),   // 5 chars / 4 = 2 tokens
		];
		// Total: ceil(5/4) + ceil(5/4) = 2 + 2 = 4 tokens
		const result = windowMessages(msgs, 4);
		expect(result).toEqual(msgs);
	});

	it("returns all messages for 2 or fewer messages even if over budget", () => {
		const msgs: LanguageModelV3Message[] = [
			textMsg("user", "x".repeat(1000)),
			textMsg("assistant", "y".repeat(1000)),
		];
		// Budget way too small, but <= 2 messages returns as-is
		const result = windowMessages(msgs, 1);
		expect(result).toEqual(msgs);
	});
});

describe("sliceHistory", () => {
	it("returns all messages when under the limit", () => {
		const msgs: LanguageModelV3Message[] = [
			textMsg("user", "Hello"),
			textMsg("assistant", "Hi"),
			textMsg("user", "How are you?"),
		];
		const result = sliceHistory(msgs, 10);
		expect(result).toEqual(msgs);
	});

	it("keeps first message plus last N groups", () => {
		const msgs: LanguageModelV3Message[] = [
			textMsg("user", "First"),       // always kept
			textMsg("assistant", "A1"),      // group 1
			textMsg("user", "Q2"),           // group 2
			textMsg("assistant", "A2"),      // group 3
			textMsg("user", "Q3"),           // group 4
			textMsg("assistant", "A3"),      // group 5
		];
		const result = sliceHistory(msgs, 2);
		// First message + last 2 groups
		expect(result[0]).toEqual(msgs[0]);
		expect(result.length).toBe(3); // first + 2 groups
		expect(result[result.length - 1]).toEqual(msgs[msgs.length - 1]);
	});

	it("drops old messages and keeps recent ones", () => {
		const msgs: LanguageModelV3Message[] = [
			textMsg("user", "Start"),           // always kept
			textMsg("assistant", "Old A1"),      // group 1 - dropped
			textMsg("user", "Old Q2"),           // group 2 - dropped
			textMsg("assistant", "Old A2"),      // group 3 - dropped
			textMsg("user", "Recent Q"),         // group 4 - kept
			textMsg("assistant", "Recent A"),    // group 5 - kept
			textMsg("user", "Latest Q"),         // group 6 - kept
		];
		const result = sliceHistory(msgs, 3);
		// First message + last 3 groups
		expect(result[0]).toEqual(msgs[0]);
		expect(result).toContainEqual(msgs[4]);
		expect(result).toContainEqual(msgs[5]);
		expect(result).toContainEqual(msgs[6]);
		// Old messages dropped
		expect(result).not.toContainEqual(msgs[1]);
		expect(result).not.toContainEqual(msgs[2]);
		expect(result).not.toContainEqual(msgs[3]);
	});

	it("returns messages unchanged when 2 or fewer", () => {
		const msgs: LanguageModelV3Message[] = [
			textMsg("user", "Hello"),
			textMsg("assistant", "Hi"),
		];
		const result = sliceHistory(msgs, 1);
		expect(result).toEqual(msgs);
	});
});
