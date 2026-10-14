// ---------------------------------------------------------------------------
// chatStore.onToolDone — what the shell learns when the agent's tool finishes.
//
// The stream's `tool.done` carries a tool's result only for a tool with an
// inline UI, so a listener gets the call's name and input and nothing else.
// The shell's agent open (`nb__open_app`) rests on that: it re-asks the
// resolver with the input. This drives the real store over a stubbed stream.
// ---------------------------------------------------------------------------

import { describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

type OnEvent = (type: string, data: unknown, seq: number) => void;
let emit: OnEvent = () => {};

mock.module("../api/client", () => ({
  ...realClient,
  startChatTurn: mock(async () => ({ conversationId: "conv_open" })),
}));

mock.module("../api/conversation-stream", () => ({
  connectConversationStream: (opts: { onEvent: OnEvent }) => {
    emit = opts.onEvent;
    return { close() {} };
  },
}));

const { createChatStore } = await import("../hooks/chat-store");
type FinishedToolCall = import("../hooks/chat-store").FinishedToolCall;

describe("onToolDone", () => {
  test("a tool.done with no result reports the call's name and input", async () => {
    const store = createChatStore();
    store.ensureSlice("draft_1");
    store.markActive("draft_1");
    const done: FinishedToolCall[] = [];
    store.onToolDone((call) => done.push(call));

    await store.sendTurn("draft_1", { text: "open my file" });
    emit("tool.start", { id: "t1", name: "nb__open_app", input: { uri: "files://f_1" } }, 1);
    emit(
      "tool.done",
      { id: "t1", name: "nb__open_app", ok: true, ms: 3, output: "Opening Files." },
      2,
    );

    expect(done).toEqual([
      { id: "t1", name: "nb__open_app", ok: true, input: { uri: "files://f_1" } },
    ]);
  });
});
