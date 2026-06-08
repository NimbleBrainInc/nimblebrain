import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ChatMessage } from "../src/hooks/chat-store.ts";

// ---------------------------------------------------------------------------
// Drive the chat store directly (no React). The store is now a *viewer* over
// the server turn stream: sendTurn → startChatTurn (POST) → subscribe via
// connectConversationStream. We mock both seams and drive the captured
// stream callback to simulate server events.
//
// Bun module mocks are process-global; we spread the real client and override
// only the turn transport so sibling suites keep the real exports.
// ---------------------------------------------------------------------------

interface CapturedStream {
  conversationId: string;
  onEvent: (type: string, data: unknown, seq: number) => void;
  onSubscribed?: (info: { isActive: boolean; activeSeq: number }) => void;
  onError?: (error: Error) => void;
  closed: boolean;
}
let streams: CapturedStream[] = [];
let convCounter = 0;

const LOADED: ChatMessage[] = [
  { role: "user", content: "loaded-q" },
  { role: "assistant", content: "loaded-a", blocks: [{ type: "text", text: "loaded-a" }] },
];

// A partial disk snapshot: the trailing assistant has no terminal event yet.
const PENDING_LOADED: ChatMessage[] = [
  { role: "user", content: "loaded-q" },
  { role: "assistant", content: "part", blocks: [{ type: "text", text: "part" }], pending: true },
];

mock.module("../src/api/conversation-stream", () => ({
  connectConversationStream: (opts: {
    conversationId: string;
    onEvent: (type: string, data: unknown, seq: number) => void;
    onSubscribed?: (info: { isActive: boolean; activeSeq: number }) => void;
    onError?: (error: Error) => void;
  }) => {
    const entry: CapturedStream = {
      conversationId: opts.conversationId,
      onEvent: opts.onEvent,
      onSubscribed: opts.onSubscribed,
      onError: opts.onError,
      closed: false,
    };
    streams.push(entry);
    return {
      close() {
        entry.closed = true;
      },
    };
  },
}));

// Captured calls into the turn transport (asserted by the retry / cancel tests).
let startCalls: Array<{ conversationId?: string; model?: string }> = [];
let cancelCalls: string[] = [];
// When true, startChatTurn parks until `resolvePendingStart()` is called — lets
// a test open the "Stop before /v1/chat/start resolves" window deterministically.
let deferStart = false;
let pendingStartResolvers: Array<() => void> = [];
function resolvePendingStart(): void {
  for (const r of pendingStartResolvers) r();
  pendingStartResolvers = [];
}

const actualClient = await import("../src/api/client");
mock.module("../src/api/client", () => ({
  ...actualClient,
  startChatTurn: (req: { conversationId?: string; model?: string }) => {
    startCalls.push(req);
    convCounter += 1;
    const id = req.conversationId ?? `conv_${convCounter}`;
    if (deferStart) {
      return new Promise<{ conversationId: string }>((resolve) => {
        pendingStartResolvers.push(() => resolve({ conversationId: id }));
      });
    }
    return Promise.resolve({ conversationId: id });
  },
  startChatTurnMultipart: (req: { conversationId?: string }) => {
    convCounter += 1;
    return Promise.resolve({ conversationId: req.conversationId ?? `conv_${convCounter}` });
  },
  cancelChatTurn: (id: string) => {
    cancelCalls.push(id);
    return Promise.resolve();
  },
  callTool: (_server: string, _action: string, args?: Record<string, unknown>) =>
    Promise.resolve({
      isError: false,
      structuredContent: {
        metadata: { id: args?.id },
        messages: args?.id === "conv_pending" ? PENDING_LOADED : LOADED,
      },
    }),
}));

import { createChatStore, freshDraftKey } from "../src/hooks/chat-store.ts";

function lastAssistant(messages: ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i];
  }
  return undefined;
}

/** The most-recently-opened stream (the one a just-sent turn subscribed to). */
function latestStream(): CapturedStream {
  return streams[streams.length - 1];
}

describe("chat-store viewer", () => {
  beforeEach(() => {
    streams = [];
    convCounter = 0;
    startCalls = [];
    cancelCalls = [];
    deferStart = false;
    pendingStartResolvers = [];
  });

  it("renders a sent turn from the server stream (echo consumed, no dup)", async () => {
    const store = createChatStore();
    await store.sendTurn("draft-1", { text: "hello" });
    const s = latestStream();

    // Server echoes the user message (consumed by the optimistic placeholder),
    // then streams the assistant.
    s.onEvent("user.message", { content: "hello" }, 1);
    s.onEvent("text.delta", { text: "hi " }, 2);
    s.onEvent("text.delta", { text: "there" }, 3);

    const snap = store.getSnapshot("draft-1");
    const users = snap.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1); // not duplicated
    expect(users[0].content).toBe("hello");
    expect(lastAssistant(snap.messages)?.content).toBe("hi there");
  });

  it("isolates concurrent turns into their own slices", async () => {
    const store = createChatStore();
    await store.sendTurn("kA", { text: "a" });
    const aStream = latestStream();
    await store.sendTurn("kB", { text: "b" });
    const bStream = latestStream();

    aStream.onEvent("user.message", { content: "a" }, 1);
    aStream.onEvent("text.delta", { text: "a1" }, 2);
    bStream.onEvent("user.message", { content: "b" }, 1);
    bStream.onEvent("text.delta", { text: "b1" }, 2);
    aStream.onEvent("text.delta", { text: "a2" }, 3);

    expect(lastAssistant(store.getSnapshot("kA").messages)?.content).toBe("a1a2");
    expect(lastAssistant(store.getSnapshot("kB").messages)?.content).toBe("b1");
  });

  it("remaps a draft to the real conversation id", async () => {
    const store = createChatStore();
    const draft = freshDraftKey();
    const seen: string[] = [];
    await store.sendTurn(draft, { text: "hi" }, { onConversationId: (id) => seen.push(id) });
    expect(seen).toEqual(["conv_1"]);
    expect(store.getSnapshot(draft).conversationId).toBe("conv_1");
    // The real id resolves to the same live slice.
    latestStream().onEvent("user.message", { content: "hi" }, 1);
    latestStream().onEvent("text.delta", { text: "yo" }, 2);
    expect(lastAssistant(store.getSnapshot("conv_1").messages)?.content).toBe("yo");
  });

  it("enforces per-slice single-flight", async () => {
    const store = createChatStore();
    const p1 = store.sendTurn("kA", { text: "first" });
    const p2 = store.sendTurn("kA", { text: "second" }); // ignored — already streaming
    await Promise.all([p1, p2]);
    // Only one turn started → one stream opened.
    expect(streams).toHaveLength(1);
  });

  it("finalizes on the terminal done event and closes the stream", async () => {
    const store = createChatStore();
    await store.sendTurn("kA", { text: "go" });
    const s = latestStream();
    s.onEvent("user.message", { content: "go" }, 1);
    s.onEvent("text.delta", { text: "partial" }, 2);
    s.onEvent("done", { response: "final answer", conversationId: "conv_1" }, 3);

    const snap = store.getSnapshot("kA");
    expect(snap.isStreaming).toBe(false);
    expect(lastAssistant(snap.messages)?.content).toBe("final answer");
    expect(s.closed).toBe(true);
  });

  it("recovers from an unwatchable turn: stops the spinner, keeps the sent message, stamps a recoverable error", async () => {
    const store = createChatStore();
    await store.sendTurn("kA", { text: "go" });
    const s = latestStream();
    expect(store.getSnapshot("kA").isStreaming).toBe(true);

    // The turn started server-side (startChatTurn resolved), but the event
    // stream fails unrecoverably (events route 403/404/auth) before any frame.
    s.onError?.(new Error("Conversation stream access denied: 403"));

    const snap = store.getSnapshot("kA");
    // Spinner cleared — no infinite hang.
    expect(snap.isStreaming).toBe(false);
    expect(snap.streamingState).toBeNull();
    // The user's message is NOT dropped (the turn really ran + persisted).
    const users = snap.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(users[0].content).toBe("go");
    // The empty assistant placeholder carries a recoverable error.
    const assistant = lastAssistant(snap.messages);
    expect(assistant?.error).toContain("Reload");
  });

  it("does not clobber a slice that is streaming on loadConversation", async () => {
    const store = createChatStore();
    await store.sendTurn("conv_1", { text: "go" });
    latestStream().onEvent("user.message", { content: "go" }, 1);
    latestStream().onEvent("text.delta", { text: "streaming-text" }, 2);

    await store.loadConversation("conv_1");
    expect(lastAssistant(store.getSnapshot("conv_1").messages)?.content).toBe("streaming-text");
  });

  it("resumes a live turn whose partial copy is on disk: trims the pending tail, replay rebuilds it", async () => {
    const store = createChatStore();
    // conv_pending's disk tail is an in-flight turn (assistant flagged pending).
    await store.loadConversation("conv_pending");
    const s = latestStream();
    // Server says the turn is live. The disk tail IS that turn's partial copy
    // (pending) → trim it so the replay rebuilds it without duplicating.
    s.onSubscribed?.({ isActive: true, activeSeq: 2 });
    expect(store.getSnapshot("conv_pending").messages).toHaveLength(0);
    // Streaming indicator shows immediately, before any replayed event arrives.
    expect(store.getSnapshot("conv_pending").isStreaming).toBe(true);

    s.onEvent("user.message", { content: "loaded-q" }, 1);
    s.onEvent("text.delta", { text: "fresh" }, 2);
    expect(lastAssistant(store.getSnapshot("conv_pending").messages)?.content).toBe("fresh");
    expect(store.getSnapshot("conv_pending").messages.filter((m) => m.role === "user")).toHaveLength(
      1,
    );
  });

  it("preserves a completed prior turn when a new turn goes active mid-resume (no transcript loss)", async () => {
    const store = createChatStore();
    // conv_X's disk tail is a COMPLETE prior turn (assistant, not pending).
    await store.loadConversation("conv_X");
    const s = latestStream();
    // The resume race: a NEW turn began on the server but hasn't persisted yet,
    // so the disk still shows only the finished prior turn. `isActive` is true,
    // but the trailing turn is NOT this active turn — it's a completed one and
    // must survive. The replay (per-run) carries only the new turn and appends
    // it after the preserved history. Trimming here was the transcript-loss bug.
    s.onSubscribed?.({ isActive: true, activeSeq: 1 });
    expect(store.getSnapshot("conv_X").messages).toEqual(LOADED);
    expect(store.getSnapshot("conv_X").isStreaming).toBe(true);

    s.onEvent("user.message", { content: "new-q" }, 1);
    s.onEvent("text.delta", { text: "new-a" }, 2);
    const msgs = store.getSnapshot("conv_X").messages;
    expect(msgs.map((m) => m.content)).toEqual(["loaded-q", "loaded-a", "new-q", "new-a"]);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(2);
  });

  it("closes an idle resume connection when nothing is in flight", async () => {
    const store = createChatStore();
    await store.loadConversation("conv_Y");
    const s = latestStream();
    s.onSubscribed?.({ isActive: false, activeSeq: 0 });
    expect(s.closed).toBe(true);
    // History still present.
    expect(store.getSnapshot("conv_Y").messages).toHaveLength(LOADED.length);
  });

  it("tracks streaming ids and clears on terminal", async () => {
    const store = createChatStore();
    await store.sendTurn(freshDraftKey(), { text: "a" });
    latestStream().onEvent("user.message", { content: "a" }, 1);
    expect(store.getStreamingIds()).toEqual(["conv_1"]);
    latestStream().onEvent("done", { response: "x", conversationId: "conv_1" }, 2);
    expect(store.getStreamingIds()).toEqual([]);
  });

  it("caps idle slices via LRU but keeps streaming ones", async () => {
    const store = createChatStore();
    await store.sendTurn(freshDraftKey(), { text: "go" });
    latestStream().onEvent("user.message", { content: "go" }, 1);
    for (let i = 0; i < 60; i++) store.ensureSlice(`idle-${i}`);
    expect(store.sliceCount()).toBeLessThanOrEqual(30);
    expect(store.getSnapshot("conv_1").isStreaming).toBe(true);
  });

  it("reset drops every slice and closes streams", async () => {
    const store = createChatStore();
    await store.sendTurn("kA", { text: "a" });
    const s = latestStream();
    expect(store.sliceCount()).toBeGreaterThan(0);
    store.reset();
    expect(store.sliceCount()).toBe(0);
    expect(s.closed).toBe(true);
    expect(store.getSnapshot("conv_1").messages).toEqual([]);
  });

  it("probeConversation lights a dot for an active conversation (no history fetch)", () => {
    const store = createChatStore();
    store.probeConversation("conv_live");
    latestStream().onSubscribed?.({ isActive: true, activeSeq: 3 });

    expect(store.getStreamingIds()).toEqual(["conv_live"]);
    // No message history was fetched — only the probe subscription.
    expect(store.getSnapshot("conv_live").messages).toEqual([]);
  });

  it("probeConversation closes and shows no dot for an inactive conversation", () => {
    const store = createChatStore();
    store.probeConversation("conv_done");
    const s = latestStream();
    s.onSubscribed?.({ isActive: false, activeSeq: 0 });

    expect(store.getStreamingIds()).toEqual([]);
    expect(s.closed).toBe(true);
  });

  it("opening a probed conversation still loads full history", async () => {
    const store = createChatStore();
    store.probeConversation("conv_x");
    latestStream().onSubscribed?.({ isActive: true, activeSeq: 3 });
    // Probe left it unhydrated despite streaming — loadConversation must fetch.
    await store.loadConversation("conv_x");
    expect(lastAssistant(store.getSnapshot("conv_x").messages)?.content).toBe("loaded-a");
  });

  it("setTitle updates a conversation's slice title (live conversation.title SSE)", async () => {
    const store = createChatStore();
    await store.sendTurn("kA", { text: "a" });
    latestStream().onEvent("chat.start", { conversationId: "A" }, 1);
    expect(store.getSnapshot("A").title).toBeNull();

    store.setTitle("A", "Library Paranoia Joke");
    expect(store.getSnapshot("A").title).toBe("Library Paranoia Joke");
  });

  it("setTitle is a no-op for a conversation with no slice in this tab", () => {
    const store = createChatStore();
    store.setTitle("conv_absent", "Whatever");
    expect(store.getSnapshot("conv_absent").title).toBeNull();
  });

  it("clears a stuck stream when a reconnect reports the turn already ended", async () => {
    const store = createChatStore();
    await store.sendTurn("kA", { text: "a" });
    const s = latestStream();
    s.onEvent("chat.start", { conversationId: "A" }, 1);
    s.onEvent("text.delta", { text: "partial" }, 2);
    expect(store.getSnapshot("A").isStreaming).toBe(true);

    // Reconnect after the turn ended while disconnected past the grace window:
    // server says not active and the terminal frame was GC'd (no replay).
    s.onSubscribed?.({ isActive: false, activeSeq: 0 });

    expect(store.getSnapshot("A").isStreaming).toBe(false);
    expect(store.getSnapshot("A").streamingState).toBeNull();
    // Last-seen partial is retained (a reload would fetch the final transcript).
    expect(lastAssistant(store.getSnapshot("A").messages)?.content).toBe("partial");
  });

  it("completes a partial disk tail from the grace replay on resume (no dup)", async () => {
    const store = createChatStore();
    await store.loadConversation("conv_pending");
    expect(lastAssistant(store.getSnapshot("conv_pending").messages)?.content).toBe("part");

    // Turn finished in the load→subscribe window but is still graced: not
    // active, retained run (activeSeq>0). The replay carries the full turn.
    const s = latestStream();
    s.onSubscribed?.({ isActive: false, activeSeq: 5 });
    s.onEvent("user.message", { content: "loaded-q" }, 1);
    s.onEvent("text.delta", { text: "full answer" }, 2);
    s.onEvent("done", { conversationId: "conv_pending", response: "full answer" }, 3);

    const msgs = store.getSnapshot("conv_pending").messages;
    expect(lastAssistant(msgs)?.content).toBe("full answer");
    expect(msgs.filter((m) => m.role === "user").length).toBe(1); // no duplicate turn
  });

  it("keeps a complete disk tail intact when a graced replay is available (no flicker)", async () => {
    const store = createChatStore();
    await store.loadConversation("conv_done2");
    const s = latestStream();
    // Complete tail + retained run: the grace replay must be ignored (not
    // trimmed+rebuilt) so the just-opened turn doesn't blink out and back.
    s.onSubscribed?.({ isActive: false, activeSeq: 9 });
    s.onEvent("user.message", { content: "loaded-q" }, 1);
    s.onEvent("done", { conversationId: "conv_done2", response: "loaded-a" }, 2);
    expect(store.getSnapshot("conv_done2").messages).toEqual(LOADED);
  });

  it("does not duplicate a finished turn whose grace-buffer replay still arrives", async () => {
    const store = createChatStore();
    // Disk already has the completed turn.
    await store.loadConversation("conv_done");
    expect(store.getSnapshot("conv_done").messages).toEqual(LOADED);

    // Resume finds no active turn, but the server still replays the recently
    // finished turn from its grace buffer. Those events must be dropped, not
    // re-appended on top of the disk history.
    const s = latestStream();
    s.onSubscribed?.({ isActive: false, activeSeq: 0 });
    s.onEvent("user.message", { content: "loaded-q" }, 1);
    s.onEvent("text.delta", { text: "loaded-a" }, 2);
    s.onEvent("done", { conversationId: "conv_done", response: "loaded-a" }, 3);

    expect(store.getSnapshot("conv_done").messages).toEqual(LOADED);
  });

  it("retry replays the original send (same model), not the workspace default", async () => {
    const store = createChatStore();
    await store.sendTurn("kA", { text: "explain", model: "anthropic:claude-opus-4-6" });
    latestStream().onEvent("error", { error: "crash", message: "Engine crashed" }, 1);

    store.retryLastMessage("kA");
    await Promise.resolve(); // let the retry's sendTurn run

    // Two starts: the original + the retry, both carrying the selected model.
    expect(startCalls).toHaveLength(2);
    expect(startCalls[1].model).toBe("anthropic:claude-opus-4-6");
    // The failed pair was dropped and re-added — exactly one user message.
    expect(store.getSnapshot("kA").messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("retry is a no-op when nothing was sent on the slice", async () => {
    const store = createChatStore();
    await store.loadConversation("conv_X"); // loaded from disk, never sent in this tab
    store.retryLastMessage("conv_X");
    await Promise.resolve();
    expect(startCalls).toHaveLength(0);
    expect(store.getSnapshot("conv_X").messages).toEqual(LOADED);
  });

  it("Stop pressed before /v1/chat/start resolves cancels once the id arrives", async () => {
    const store = createChatStore();
    deferStart = true;
    // A fresh draft has no conversationId until the POST resolves — exactly the
    // window where Stop used to be a silent no-op.
    const key = freshDraftKey();
    const sent = store.sendTurn(key, { text: "go" });
    // The POST is parked — no conversationId yet. Press Stop.
    store.cancelTurn(key);
    expect(cancelCalls).toHaveLength(0); // nothing to cancel yet — latched

    resolvePendingStart();
    await sent;

    // The deferred cancel fired with the now-known conversationId.
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0]).toBe("conv_1");
  });

  it("onError closes the stream so reopening refetches the persisted result", async () => {
    const store = createChatStore();
    await store.sendTurn("kA", { text: "watch me" });
    const s = latestStream();
    s.onEvent("text.delta", { text: "partial" }, 1);
    expect(store.getSnapshot("kA").isStreaming).toBe(true);

    // The viewer stream dies (e.g. 403/404 on the events route). The turn ran
    // server-side; this is a watch failure. The connection must be closed so a
    // later open isn't blocked from refetching.
    s.onError?.(new Error("Conversation stream access denied: 404"));
    expect(s.closed).toBe(true);
    expect(store.getSnapshot("kA").isStreaming).toBe(false);
  });

  it("reattachStreaming re-opens a resume stream after a bfcache restore", async () => {
    const store = createChatStore();
    await store.sendTurn("kA", { text: "go" });
    const before = latestStream();
    expect(store.getSnapshot("kA").isStreaming).toBe(true);

    // pagehide: sockets closed, slice state (isStreaming) deliberately kept.
    store.closeAllConnections();
    expect(before.closed).toBe(true);
    expect(store.getSnapshot("kA").isStreaming).toBe(true);

    // bfcache restore: re-attach opens a fresh resume stream (not the dead one).
    store.reattachStreaming();
    const after = latestStream();
    expect(after).not.toBe(before);

    // The resume reconciles: the server says the turn already ended → the
    // otherwise-wedged spinner clears.
    after.onSubscribed?.({ isActive: false, activeSeq: 0 });
    expect(store.getSnapshot("kA").isStreaming).toBe(false);
  });

  it("reattachStreaming re-tails a STILL-ACTIVE turn without duplicating the user message", async () => {
    const store = createChatStore();
    await store.sendTurn("kA", { text: "go" });
    const before = latestStream();
    // Live stream got far enough to consume the optimistic echo + render partial.
    before.onEvent("user.message", { content: "go" }, 1);
    before.onEvent("text.delta", { text: "partial" }, 2);
    expect(store.getSnapshot("kA").messages.map((m) => m.content)).toEqual(["go", "partial"]);

    // bfcache: sockets closed, isStreaming kept; the in-memory tail is the
    // in-flight turn, built live so it carries NO disk `pending` flag.
    store.closeAllConnections();
    store.reattachStreaming();
    const after = latestStream();
    expect(after).not.toBe(before);

    // Turn is still running. The resume replays from seq 1 (afterSeq:0),
    // including the user.message echo — it must NOT append a second turn.
    after.onSubscribed?.({ isActive: true, activeSeq: 2 });
    after.onEvent("user.message", { content: "go" }, 1);
    after.onEvent("text.delta", { text: "partial" }, 2);
    after.onEvent("text.delta", { text: " done" }, 3);

    const msgs = store.getSnapshot("kA").messages;
    expect(msgs.map((m) => m.content)).toEqual(["go", "partial done"]);
    expect(msgs.filter((m) => m.role === "user")).toHaveLength(1);
  });
});
