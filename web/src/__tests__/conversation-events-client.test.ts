// ---------------------------------------------------------------------------
// conversation-events-client.ts — keyed conversation SSE singleton
//
// Mocks `./api/conversation-sse` so the singleton can be driven without
// touching the network. Verifies the per-conversation ref-counted
// open/close semantic, which is the contract that prevents the latent
// "two consumers → two connections" regression even though today only
// one consumer (ChatContext) subscribes.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ConversationSseConnection, ConversationSseOptions } from "../api/conversation-sse";

let connectCalls = 0;
let closeCalls = 0;
const optionsByConvId = new Map<string, ConversationSseOptions>();

class FakeConvConnection implements ConversationSseConnection {
  closed = false;
  conversationId: string;
  constructor(conversationId: string) {
    this.conversationId = conversationId;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeCalls += 1;
  }
}

const liveConnections: FakeConvConnection[] = [];

function fakeConnectConversationEvents(options: ConversationSseOptions): ConversationSseConnection {
  connectCalls += 1;
  optionsByConvId.set(options.conversationId, options);
  const conn = new FakeConvConnection(options.conversationId);
  liveConnections.push(conn);
  return conn;
}

mock.module("../api/conversation-sse", () => ({
  connectConversationEvents: fakeConnectConversationEvents,
}));

// Import AFTER mocking so the singleton sees the fake.
import { setAuthLifecycleHandler, setAuthToken } from "../api/client";
import {
  __internal__,
  closeAllConversationEvents,
  subscribeConversation,
} from "../api/conversation-events-client";

function resetCounters(): void {
  connectCalls = 0;
  closeCalls = 0;
  optionsByConvId.clear();
  liveConnections.length = 0;
}

beforeEach(() => {
  resetCounters();
  setAuthToken("tok-initial");
  __internal__.resetForTest();
});

afterEach(() => {
  __internal__.resetForTest();
  setAuthLifecycleHandler(null);
  setAuthToken(null);
});

describe("conversation-events-client — keyed singleton", () => {
  test("first subscribe for a conversation opens exactly one connection", () => {
    subscribeConversation("conv_a", { onEvent: () => {} });
    expect(connectCalls).toBe(1);
    expect(__internal__.hasConnection("conv_a")).toBe(true);
    expect(__internal__.connectionCount()).toBe(1);
  });

  test("multiple subscribers to the same conversation share one connection", () => {
    subscribeConversation("conv_a", { onEvent: () => {} });
    subscribeConversation("conv_a", { onEvent: () => {} });
    subscribeConversation("conv_a", { onEvent: () => {} });
    expect(connectCalls).toBe(1);
    expect(__internal__.connectionCount()).toBe(1);
  });

  test("different conversations get their own connections", () => {
    subscribeConversation("conv_a", { onEvent: () => {} });
    subscribeConversation("conv_b", { onEvent: () => {} });
    expect(connectCalls).toBe(2);
    expect(__internal__.connectionCount()).toBe(2);
    expect(__internal__.hasConnection("conv_a")).toBe(true);
    expect(__internal__.hasConnection("conv_b")).toBe(true);
  });
});

describe("conversation-events-client — event fan-out", () => {
  test("events route to every subscriber of the same conversation", () => {
    const a = mock(() => {});
    const b = mock(() => {});
    const other = mock(() => {});
    subscribeConversation("conv_a", { onEvent: a });
    subscribeConversation("conv_a", { onEvent: b });
    subscribeConversation("conv_b", { onEvent: other });

    optionsByConvId.get("conv_a")?.onEvent("text.delta", { delta: "hi" });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(0);
  });

  test("onReconnect fires for every registered reconnect handler", () => {
    const a = mock(() => {});
    const b = mock(() => {});
    subscribeConversation("conv_a", { onEvent: () => {}, onReconnect: a });
    subscribeConversation("conv_a", { onEvent: () => {}, onReconnect: b });

    optionsByConvId.get("conv_a")?.onReconnect?.();

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  test("a throwing handler does not block siblings", () => {
    const thrower = mock(() => {
      throw new Error("boom");
    });
    const good = mock(() => {});
    subscribeConversation("conv_a", { onEvent: thrower });
    subscribeConversation("conv_a", { onEvent: good });

    optionsByConvId.get("conv_a")?.onEvent("text.delta", {});

    expect(thrower).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("conversation-events-client — ref-counted teardown", () => {
  test("last unsubscribe closes the conversation's connection", () => {
    const unsubA = subscribeConversation("conv_a", { onEvent: () => {} });
    const unsubB = subscribeConversation("conv_a", { onEvent: () => {} });
    expect(__internal__.connectionCount()).toBe(1);

    unsubA();
    // Still one subscriber → connection stays.
    expect(__internal__.hasConnection("conv_a")).toBe(true);
    expect(closeCalls).toBe(0);

    unsubB();
    // No subscribers → close.
    expect(__internal__.hasConnection("conv_a")).toBe(false);
    expect(closeCalls).toBe(1);
  });

  test("unsubscribing one conversation doesn't affect others", () => {
    const unsubA = subscribeConversation("conv_a", { onEvent: () => {} });
    subscribeConversation("conv_b", { onEvent: () => {} });

    unsubA();
    expect(__internal__.hasConnection("conv_a")).toBe(false);
    expect(__internal__.hasConnection("conv_b")).toBe(true);
  });

  test("unsubscribe is idempotent (calling twice is safe)", () => {
    const unsub = subscribeConversation("conv_a", { onEvent: () => {} });
    unsub();
    expect(() => unsub()).not.toThrow();
    expect(closeCalls).toBe(1);
  });
});

describe("conversation-events-client — auth lifecycle", () => {
  test("auth-lifecycle fire closes every active conversation stream", () => {
    subscribeConversation("conv_a", { onEvent: () => {} });
    subscribeConversation("conv_b", { onEvent: () => {} });
    expect(__internal__.connectionCount()).toBe(2);

    setAuthToken(null);

    expect(__internal__.connectionCount()).toBe(0);
    // No auto-rebuild — conversation streams are user-driven.
  });

  test("closeAllConversationEvents is idempotent", () => {
    expect(() => closeAllConversationEvents()).not.toThrow();
    expect(closeCalls).toBe(0);
    subscribeConversation("conv_a", { onEvent: () => {} });
    closeAllConversationEvents();
    expect(closeCalls).toBe(1);
    expect(() => closeAllConversationEvents()).not.toThrow();
  });
});
