import { describe, expect, it, mock, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatProvider, useChatContext } from "../src/context/ChatContext.tsx";

// ---------------------------------------------------------------------------
// Mock streamChat so we can control SSE events in tests
// ---------------------------------------------------------------------------

type StreamCallback = (type: string, data: unknown) => void;

let capturedCallback: StreamCallback | null = null;
let resolveStream: (() => void) | null = null;
let rejectStream: ((err: Error) => void) | null = null;

mock.module("../src/api/client", () => ({
	streamChat: (_req: unknown, cb: StreamCallback) => {
		capturedCallback = cb;
		return new Promise<void>((resolve, reject) => {
			resolveStream = resolve;
			rejectStream = reject;
		});
	},
	getConversationHistory: mock(() =>
		Promise.resolve({ conversationId: "c1", messages: [] }),
	),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapper({ children }: { children: ReactNode }) {
	return <ChatProvider>{children}</ChatProvider>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("inline error UX", () => {
	beforeEach(() => {
		capturedCallback = null;
		resolveStream = null;
		rejectStream = null;
	});

	it("stream error event stamps error on last assistant message, not banner", async () => {
		const { result } = renderHook(() => useChatContext(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});

		// Simulate some streaming content first
		act(() => {
			capturedCallback?.("text.delta", { text: "Here is my response" });
		});

		// Fire SSE error event
		act(() => {
			capturedCallback?.("error", {
				error: "json_parse",
				message: "JSON Parse error: Unable to parse JSON string",
			});
		});

		// Error should be on the last assistant message
		const lastMsg = result.current.messages[result.current.messages.length - 1];
		expect(lastMsg?.role).toBe("assistant");
		expect(lastMsg?.error).toBe("JSON Parse error: Unable to parse JSON string");

		// Banner error should NOT be set
		expect(result.current.error).toBeNull();
	});

	it("simulateError is a no-op when there are no messages", () => {
		const { result } = renderHook(() => useChatContext(), { wrapper });

		expect(result.current.messages).toHaveLength(0);

		act(() => {
			result.current.simulateError("Something broke");
		});

		// No messages to stamp on — stays empty
		expect(result.current.messages).toHaveLength(0);
		expect(result.current.isStreaming).toBe(false);
		expect(result.current.streamingState).toBeNull();
	});

	it("simulateError stamps on existing assistant message", async () => {
		const { result } = renderHook(() => useChatContext(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});

		act(() => {
			capturedCallback?.("text.delta", { text: "response text" });
		});

		// Complete the stream so isStreaming is false
		act(() => {
			capturedCallback?.("done", {
				response: "response text",
				conversationId: "c1",
				toolCalls: [],
				inputTokens: 10,
				outputTokens: 5,
				stopReason: "complete",
			});
		});
		act(() => {
			resolveStream?.();
		});
		await act(async () => {});

		const msgCountBefore = result.current.messages.length;

		act(() => {
			result.current.simulateError("Simulated crash");
		});

		// Should stamp on existing message, not add a new one
		expect(result.current.messages).toHaveLength(msgCountBefore);
		const lastMsg = result.current.messages[result.current.messages.length - 1];
		expect(lastMsg?.role).toBe("assistant");
		expect(lastMsg?.error).toBe("Simulated crash");
	});

	it("retryLastMessage removes failed pair and re-sends", async () => {
		const { result } = renderHook(() => useChatContext(), { wrapper });

		// Send a message
		act(() => {
			result.current.sendMessage("try this");
		});
		await act(async () => {});

		// Simulate some content then error
		act(() => {
			capturedCallback?.("text.delta", { text: "partial" });
		});
		act(() => {
			capturedCallback?.("error", {
				error: "crash",
				message: "Engine crashed",
			});
		});

		// Complete the stream promise so isStreaming clears
		act(() => {
			resolveStream?.();
		});
		await act(async () => {});

		// Should have user + errored assistant
		expect(result.current.messages).toHaveLength(2);
		expect(result.current.messages[1].error).toBe("Engine crashed");

		// Reset mocks for the retry
		capturedCallback = null;
		resolveStream = null;

		// Retry
		act(() => {
			result.current.retryLastMessage();
		});
		await act(async () => {});

		// retryLastMessage removes the failed pair and triggers a new send.
		// After retry fires, we should have a new user + assistant placeholder.
		// The callback should be captured again from the new sendMessage call.
		// Give it another tick for the effect to fire sendMessage
		await act(async () => {});

		// The retry effect should have fired sendMessage, creating new messages
		expect(result.current.isStreaming).toBe(true);
	});
});
