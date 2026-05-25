import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { ChatProvider, useChatContext } from "../src/context/ChatContext.tsx";
import type { ChatMessage } from "../src/hooks/useChat.ts";

// ---------------------------------------------------------------------------
// Regression for #254 under the server-authoritative model: a turn streaming
// in conversation A must NOT bleed into B when the user switches mid-turn.
// Each conversation is a viewer over its own server stream; switching away
// keeps A's stream filling A's slice in the background.
// ---------------------------------------------------------------------------

type StreamCb = (type: string, data: unknown, seq: number) => void;
const streamsByConv = new Map<string, StreamCb>();
const subscribedByConv = new Map<string, (info: { isActive: boolean; activeSeq: number }) => void>();

const B_MESSAGES: ChatMessage[] = [
  { role: "user", content: "b-question" },
  { role: "assistant", content: "b-answer", blocks: [{ type: "text", text: "b-answer" }] },
];

mock.module("../src/api/conversation-stream", () => ({
  connectConversationStream: (opts: {
    conversationId: string;
    onEvent: StreamCb;
    onSubscribed?: (info: { isActive: boolean; activeSeq: number }) => void;
  }) => {
    streamsByConv.set(opts.conversationId, opts.onEvent);
    if (opts.onSubscribed) subscribedByConv.set(opts.conversationId, opts.onSubscribed);
    return {
      close() {
        streamsByConv.delete(opts.conversationId);
        subscribedByConv.delete(opts.conversationId);
      },
    };
  },
}));

const actualClient = await import("../src/api/client");
mock.module("../src/api/client", () => ({
  ...actualClient,
  startChatTurn: () => Promise.resolve({ conversationId: "conv-A" }),
  startChatTurnMultipart: () => Promise.resolve({ conversationId: "conv-A" }),
  cancelChatTurn: () => Promise.resolve(),
  callTool: (server: string, action: string, args?: Record<string, unknown>) => {
    if (server === "conversations" && action === "get") {
      return Promise.resolve({
        isError: false,
        structuredContent: { metadata: { id: args?.id }, messages: B_MESSAGES },
      });
    }
    return Promise.resolve({ isError: false, structuredContent: {} });
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  return <ChatProvider>{children}</ChatProvider>;
}

function lastAssistant(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return undefined;
}

describe("#254 mid-turn conversation switch (server-authoritative)", () => {
  beforeEach(() => {
    streamsByConv.clear();
    subscribedByConv.clear();
  });

  it("does not bleed A's streaming deltas into conversation B", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });

    await act(async () => {
      await result.current.sendMessage("a-question");
    });

    act(() => {
      streamsByConv.get("conv-A")?.("user.message", { content: "a-question" }, 1);
      streamsByConv.get("conv-A")?.("text.delta", { text: "A-part1" }, 2);
    });

    await act(async () => {
      await result.current.loadConversation("conv-B");
    });
    act(() => {
      subscribedByConv.get("conv-B")?.({ isActive: false, activeSeq: 0 });
    });

    expect(result.current.conversationId).toBe("conv-B");
    expect(lastAssistant(result.current.messages)?.content).toBe("b-answer");

    // A keeps streaming in the background.
    act(() => {
      streamsByConv.get("conv-A")?.("text.delta", { text: "A-part2" }, 3);
    });

    expect(lastAssistant(result.current.messages)?.content).toBe("b-answer");
  });

  it("keeps A's background stream so switching back shows the response", async () => {
    const { result } = renderHook(() => useChatContext(), { wrapper });

    await act(async () => {
      await result.current.sendMessage("a-question");
    });
    act(() => {
      streamsByConv.get("conv-A")?.("user.message", { content: "a-question" }, 1);
      streamsByConv.get("conv-A")?.("text.delta", { text: "A1" }, 2);
    });

    await act(async () => {
      await result.current.loadConversation("conv-B");
    });
    act(() => {
      subscribedByConv.get("conv-B")?.({ isActive: false, activeSeq: 0 });
      streamsByConv.get("conv-A")?.("text.delta", { text: "A2" }, 3);
    });

    await act(async () => {
      await result.current.loadConversation("conv-A");
    });
    expect(result.current.conversationId).toBe("conv-A");
    expect(lastAssistant(result.current.messages)?.content).toBe("A1A2");
  });
});
