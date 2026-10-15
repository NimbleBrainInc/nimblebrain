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

  test("a held call is neither announced nor shown; its re-issue is", async () => {
    const store = createChatStore();
    store.ensureSlice("draft_2");
    store.markActive("draft_2");
    const done: FinishedToolCall[] = [];
    store.onToolDone((call) => done.push(call));

    await store.sendTurn("draft_2", { text: "write the email" });
    emit("tool.start", { id: "h1", name: "outreach__draft_email", input: {} }, 1);
    emit(
      "tool.done",
      {
        id: "h1",
        name: "outreach__draft_email",
        ok: false,
        ms: 0,
        output: "Not run: outreach__draft_email is governed by guidance you have not read yet.",
        held: true,
      },
      2,
    );
    emit("tool.start", { id: "r1", name: "outreach__draft_email", input: {} }, 3);
    emit(
      "tool.done",
      { id: "r1", name: "outreach__draft_email", ok: true, ms: 4, output: "ok" },
      4,
    );

    expect(done.map((d) => d.id)).toEqual(["r1"]);
    const shown = JSON.stringify(store.getSnapshot("draft_2").messages);
    expect(shown).toContain('"r1"');
    expect(shown).not.toContain('"h1"');
  });
});
