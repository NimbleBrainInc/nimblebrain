import { describe, expect, it, mock, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { ChatProvider, useChatContext } from "../src/context/ChatContext.tsx";
import type { StreamingState } from "../src/hooks/useChat.ts";

// ---------------------------------------------------------------------------
// Mock streamChat so we can control SSE events in tests
// ---------------------------------------------------------------------------

type StreamCallback = (type: string, data: unknown) => void;

let capturedCallback: StreamCallback | null = null;
let resolveStream: (() => void) | null = null;

mock.module("../src/api/client", () => ({
	streamChat: (_req: unknown, cb: StreamCallback) => {
		capturedCallback = cb;
		return new Promise<void>((resolve) => {
			resolveStream = resolve;
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

function useStreamingState() {
	const ctx = useChatContext();
	return ctx;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("streamingState state machine", () => {
	beforeEach(() => {
		capturedCallback = null;
		resolveStream = null;
	});

	it("starts as null", () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });
		expect(result.current.streamingState).toBeNull();
	});

	it("transitions to thinking when sendMessage is called", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		// sendMessage returns a promise; don't await (stream is pending)
		act(() => {
			result.current.sendMessage("hello");
		});

		// Wait a tick for state to settle
		await act(async () => {});

		expect(result.current.streamingState).toBe("thinking" as StreamingState);
	});

	it("transitions thinking → streaming on first text.delta", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});

		expect(result.current.streamingState).toBe("thinking");

		act(() => {
			capturedCallback?.("text.delta", { text: "Hi" });
		});

		expect(result.current.streamingState).toBe("streaming");
	});

	it("transitions streaming → working on tool.start", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});

		act(() => {
			capturedCallback?.("text.delta", { text: "Let me check" });
		});
		expect(result.current.streamingState).toBe("streaming");

		act(() => {
			capturedCallback?.("tool.start", { id: "t1", name: "search" });
		});
		expect(result.current.streamingState).toBe("working");
	});

	it("transitions working → analyzing on last tool.done", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});

		act(() => {
			capturedCallback?.("text.delta", { text: "x" });
		});
		act(() => {
			capturedCallback?.("tool.start", { id: "t1", name: "search" });
		});
		expect(result.current.streamingState).toBe("working");

		act(() => {
			capturedCallback?.("tool.done", { id: "t1", name: "search", ok: true, ms: 100 });
		});
		// No in-flight tools remain → model is inferring on the result.
		expect(result.current.streamingState).toBe("analyzing");
	});

	it("holds working while parallel tools are still in flight, then analyzing", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});

		act(() => {
			capturedCallback?.("tool.start", { id: "a", name: "search" });
			capturedCallback?.("tool.start", { id: "b", name: "fetch" });
		});
		expect(result.current.streamingState).toBe("working");

		// First of two completes — the other is still running, so stay `working`.
		act(() => {
			capturedCallback?.("tool.done", { id: "a", name: "search", ok: true, ms: 10 });
		});
		expect(result.current.streamingState).toBe("working");

		// Last one lands → flip to `analyzing`.
		act(() => {
			capturedCallback?.("tool.done", { id: "b", name: "fetch", ok: false, ms: 725 });
		});
		expect(result.current.streamingState).toBe("analyzing");
	});

	it("transitions analyzing → streaming on the next text.delta", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});

		act(() => {
			capturedCallback?.("tool.start", { id: "t1", name: "search" });
			capturedCallback?.("tool.done", { id: "t1", name: "search", ok: true, ms: 10 });
		});
		expect(result.current.streamingState).toBe("analyzing");

		act(() => {
			capturedCallback?.("text.delta", { text: "Based on that…" });
		});
		expect(result.current.streamingState).toBe("streaming");
	});

	it("transitions analyzing → working when the model calls another tool", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});

		act(() => {
			capturedCallback?.("tool.start", { id: "t1", name: "search" });
			capturedCallback?.("tool.done", { id: "t1", name: "search", ok: true, ms: 10 });
		});
		expect(result.current.streamingState).toBe("analyzing");

		act(() => {
			capturedCallback?.("tool.start", { id: "t2", name: "fetch" });
		});
		expect(result.current.streamingState).toBe("working");
	});

	it("transitions to null on done event", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});

		act(() => {
			capturedCallback?.("text.delta", { text: "Hi" });
		});
		expect(result.current.streamingState).toBe("streaming");

		act(() => {
			capturedCallback?.("done", {
				conversationId: "c1",
				response: "Hi",
			});
		});
		expect(result.current.streamingState).toBeNull();
	});

	it("transitions to null on error event", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});

		expect(result.current.streamingState).toBe("thinking");

		act(() => {
			capturedCallback?.("error", { error: "fail", message: "fail" });
		});
		expect(result.current.streamingState).toBeNull();
	});

	it("transitions to null in finally after stream resolves", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});

		expect(result.current.streamingState).toBe("thinking");

		// Resolve the stream promise (triggers finally block)
		await act(async () => {
			resolveStream?.();
		});

		expect(result.current.streamingState).toBeNull();
	});

	it("newConversation resets streamingState to null", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		act(() => {
			result.current.newConversation();
		});

		expect(result.current.streamingState).toBeNull();
	});

	it("full cycle: thinking → streaming → working → analyzing → streaming → null", async () => {
		const { result } = renderHook(() => useStreamingState(), { wrapper });

		act(() => {
			result.current.sendMessage("hello");
		});
		await act(async () => {});
		expect(result.current.streamingState).toBe("thinking");

		act(() => {
			capturedCallback?.("text.delta", { text: "Let me " });
		});
		expect(result.current.streamingState).toBe("streaming");

		act(() => {
			capturedCallback?.("tool.start", { id: "t1", name: "lookup" });
		});
		expect(result.current.streamingState).toBe("working");

		act(() => {
			capturedCallback?.("tool.done", { id: "t1", name: "lookup", ok: true, ms: 50 });
		});
		expect(result.current.streamingState).toBe("analyzing");

		act(() => {
			capturedCallback?.("text.delta", { text: "here you go" });
		});
		expect(result.current.streamingState).toBe("streaming");

		act(() => {
			capturedCallback?.("done", {
				conversationId: "c1",
				response: "Let me here you go",
			});
		});
		expect(result.current.streamingState).toBeNull();

		// Resolve the stream so the finally block runs
		await act(async () => {
			resolveStream?.();
		});
		expect(result.current.streamingState).toBeNull();
	});
});
