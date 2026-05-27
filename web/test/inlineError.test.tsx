import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { realClient } from "./setup";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { ChatProvider, useChatContext } from "../src/context/ChatContext.tsx";

// ---------------------------------------------------------------------------
// Inline error UX under the server-authoritative path. We capture the turn
// stream's onEvent and push synthetic server events.
// ---------------------------------------------------------------------------

type StreamCb = (type: string, data: unknown, seq: number) => void;
let capturedOnEvent: StreamCb | null = null;

mock.module("../src/api/conversation-stream", () => ({
  connectConversationStream: (opts: { onEvent: StreamCb }) => {
    capturedOnEvent = opts.onEvent;
    return { close() {} };
  },
}));

// Spread the preload's real-module snapshot (see web/test/setup.ts) so this
// whole-module mock exposes every api/client export; only the three below are
// overridden. Bun's mock.module registry is process-global, so an incomplete
// stub leaking into another suite's module graph is what crashed bridge tests
// with "Export named 'getActiveWorkspaceId' not found".
mock.module("../src/api/client", () => ({
  ...realClient,
  startChatTurn: () => Promise.resolve({ conversationId: "c1" }),
  startChatTurnMultipart: () => Promise.resolve({ conversationId: "c1" }),
  cancelChatTurn: () => Promise.resolve(),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <ChatProvider>{children}</ChatProvider>
    </MemoryRouter>
  );
}

let seq = 0;
function emit(type: string, data: unknown): void {
  seq += 1;
  capturedOnEvent?.(type, data, seq);
}

describe("inline error UX", () => {
  beforeEach(() => {
    capturedOnEvent = null;
    seq = 0;
  });

  it("stream error event stamps error on last assistant message, not banner", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });

    act(() => emit("text.delta", { text: "Here is my response" }));
    act(() =>
      emit("error", {
        error: "json_parse",
        message: "JSON Parse error: Unable to parse JSON string",
      }),
    );

    const lastMsg = result.current.messages[result.current.messages.length - 1];
    expect(lastMsg?.role).toBe("assistant");
    expect(lastMsg?.error).toBe("JSON Parse error: Unable to parse JSON string");
    expect(result.current.error).toBeNull();
  });

  it("simulateError is a no-op when there are no messages", () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    expect(result.current.messages).toHaveLength(0);
    act(() => {
      result.current.simulateError("Something broke");
    });
    expect(result.current.messages).toHaveLength(0);
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.streamingState).toBeNull();
  });

  it("simulateError stamps on existing assistant message", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("hello");
    });
    act(() => emit("text.delta", { text: "response text" }));
    act(() =>
      emit("done", {
        response: "response text",
        conversationId: "c1",
        toolCalls: [],
        stopReason: "complete",
      }),
    );

    const msgCountBefore = result.current.messages.length;
    act(() => {
      result.current.simulateError("Simulated crash");
    });
    expect(result.current.messages).toHaveLength(msgCountBefore);
    const lastMsg = result.current.messages[result.current.messages.length - 1];
    expect(lastMsg?.role).toBe("assistant");
    expect(lastMsg?.error).toBe("Simulated crash");
  });

  it("retryLastMessage removes failed pair and re-sends", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });
    await act(async () => {
      await result.current.sendMessage("try this");
    });
    act(() => emit("text.delta", { text: "partial" }));
    act(() => emit("error", { error: "crash", message: "Engine crashed" }));

    expect(result.current.messages).toHaveLength(2);
    expect(result.current.messages[1].error).toBe("Engine crashed");

    await act(async () => {
      result.current.retryLastMessage();
    });
    await act(async () => {});

    expect(result.current.isStreaming).toBe(true);
  });
});
