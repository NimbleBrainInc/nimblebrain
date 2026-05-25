import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { ChatProvider, useChatContext } from "../src/context/ChatContext.tsx";
import type { StreamingState } from "../src/hooks/useChat.ts";

// ---------------------------------------------------------------------------
// Drive the streaming state machine through the server-authoritative path:
// sendMessage → startChatTurn (POST) → subscribe via connectConversationStream.
// We capture the stream's onEvent and push synthetic server events.
// ---------------------------------------------------------------------------

type StreamCb = (type: string, data: unknown, seq: number) => void;
let capturedOnEvent: StreamCb | null = null;

mock.module("../src/api/conversation-stream", () => ({
  connectConversationStream: (opts: { onEvent: StreamCb }) => {
    capturedOnEvent = opts.onEvent;
    return { close() {} };
  },
}));

const actualClient = await import("../src/api/client");
mock.module("../src/api/client", () => ({
  ...actualClient,
  startChatTurn: () => Promise.resolve({ conversationId: "c1" }),
  startChatTurnMultipart: () => Promise.resolve({ conversationId: "c1" }),
  cancelChatTurn: () => Promise.resolve(),
}));

function wrapper({ children }: { children: ReactNode }) {
  return <ChatProvider>{children}</ChatProvider>;
}

let seq = 0;
function emit(type: string, data: unknown): void {
  seq += 1;
  capturedOnEvent?.(type, data, seq);
}

describe("streamingState state machine", () => {
  beforeEach(() => {
    capturedOnEvent = null;
    seq = 0;
  });

  it("starts as null", () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    expect(result.current.streamingState).toBeNull();
  });

  it("transitions to thinking when sendMessage is called", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    expect(result.current.streamingState).toBe("thinking" as StreamingState);
  });

  it("transitions thinking → streaming on first text.delta", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    expect(result.current.streamingState).toBe("thinking");
    act(() => emit("text.delta", { text: "Hi" }));
    expect(result.current.streamingState).toBe("streaming");
  });

  it("transitions streaming → working on tool.start", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    act(() => emit("text.delta", { text: "Let me check" }));
    expect(result.current.streamingState).toBe("streaming");
    act(() => emit("tool.start", { id: "t1", name: "search" }));
    expect(result.current.streamingState).toBe("working");
  });

  it("transitions working → analyzing on last tool.done", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    act(() => emit("text.delta", { text: "x" }));
    act(() => emit("tool.start", { id: "t1", name: "search" }));
    expect(result.current.streamingState).toBe("working");
    act(() => emit("tool.done", { id: "t1", name: "search", ok: true, ms: 100 }));
    expect(result.current.streamingState).toBe("analyzing");
  });

  it("holds working while parallel tools are still in flight, then analyzing", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    act(() => {
      emit("tool.start", { id: "a", name: "search" });
      emit("tool.start", { id: "b", name: "fetch" });
    });
    expect(result.current.streamingState).toBe("working");
    act(() => emit("tool.done", { id: "a", name: "search", ok: true, ms: 10 }));
    expect(result.current.streamingState).toBe("working");
    act(() => emit("tool.done", { id: "b", name: "fetch", ok: false, ms: 725 }));
    expect(result.current.streamingState).toBe("analyzing");
  });

  it("transitions analyzing → streaming on the next text.delta", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    act(() => {
      emit("tool.start", { id: "t1", name: "search" });
      emit("tool.done", { id: "t1", name: "search", ok: true, ms: 10 });
    });
    expect(result.current.streamingState).toBe("analyzing");
    act(() => emit("text.delta", { text: "Based on that…" }));
    expect(result.current.streamingState).toBe("streaming");
  });

  it("transitions analyzing → working when the model calls another tool", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    act(() => {
      emit("tool.start", { id: "t1", name: "search" });
      emit("tool.done", { id: "t1", name: "search", ok: true, ms: 10 });
    });
    expect(result.current.streamingState).toBe("analyzing");
    act(() => emit("tool.start", { id: "t2", name: "fetch" }));
    expect(result.current.streamingState).toBe("working");
  });

  it("transitions to null on done event", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    act(() => emit("text.delta", { text: "Hi" }));
    expect(result.current.streamingState).toBe("streaming");
    act(() => emit("done", { conversationId: "c1", response: "Hi" }));
    expect(result.current.streamingState).toBeNull();
  });

  it("transitions to null on error event", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    expect(result.current.streamingState).toBe("thinking");
    act(() => emit("error", { error: "fail", message: "fail" }));
    expect(result.current.streamingState).toBeNull();
  });

  it("transitions to null on cancelled event", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    expect(result.current.streamingState).toBe("thinking");
    act(() => emit("cancelled", {}));
    expect(result.current.streamingState).toBeNull();
  });

  it("newConversation resets streamingState to null", () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    act(() => {
      result.current.newConversation();
    });
    expect(result.current.streamingState).toBeNull();
  });

  it("full cycle: thinking → streaming → working → analyzing → streaming → null", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    expect(result.current.streamingState).toBe("thinking");
    act(() => emit("text.delta", { text: "Let me " }));
    expect(result.current.streamingState).toBe("streaming");
    act(() => emit("tool.start", { id: "t1", name: "lookup" }));
    expect(result.current.streamingState).toBe("working");
    act(() => emit("tool.done", { id: "t1", name: "lookup", ok: true, ms: 50 }));
    expect(result.current.streamingState).toBe("analyzing");
    act(() => emit("text.delta", { text: "here you go" }));
    expect(result.current.streamingState).toBe("streaming");
    act(() => emit("done", { conversationId: "c1", response: "Let me here you go" }));
    expect(result.current.streamingState).toBeNull();
  });
});
