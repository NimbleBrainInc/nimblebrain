/**
 * Coverage for the per-conversation SSE fan-out: the `subscribed` frame, and
 * live RunBus events reaching every subscriber of their conversation and no
 * other.
 */

import { describe, expect, test } from "bun:test";
import { ConversationEventManager } from "../../../src/api/conversation-events.ts";

const decoder = new TextDecoder();

/**
 * Drain everything currently queued on the ReadableStream into an
 * array of decoded chunks. Each `read()` is raced against a short
 * timer so we stop after queued chunks drain instead of waiting for
 * the stream to close.
 */
async function drainImmediately(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    const next = reader.read();
    const settled = await Promise.race([
      next.then((r) => ({ kind: "read" as const, r })),
      new Promise<{ kind: "tick" }>((resolve) => setTimeout(() => resolve({ kind: "tick" }), 10)),
    ]);
    if (settled.kind === "tick") {
      reader.releaseLock();
      return chunks;
    }
    if (settled.r.done) {
      reader.releaseLock();
      return chunks;
    }
    chunks.push(decoder.decode(settled.r.value));
  }
}

/** Skip the initial `event: subscribed` frame the manager emits on subscribe. */
function broadcastFrames(chunks: string[]): string[] {
  return chunks.filter((c) => !c.includes("event: subscribed"));
}

describe("ConversationEventManager", () => {
  test("addSubscriber emits an initial `event: subscribed` frame", async () => {
    const mgr = new ConversationEventManager(60_000);
    const convId = "conv_aaaaaaaaaaaa1111";

    const { stream } = mgr.addSubscriber(convId, "usr_alice", undefined, {
      isActive: true,
      activeSeq: 3,
    });

    const chunks = await drainImmediately(stream);
    const subscribed = chunks.find((c) => c.startsWith("event: subscribed"));
    expect(subscribed).toBeDefined();
    expect(subscribed).toContain('"isActive":true');
    expect(subscribed).toContain('"activeSeq":3');

    mgr.stop();
  });

  test("publishEvent fans out to every subscriber on the conversation, with its seq", async () => {
    const mgr = new ConversationEventManager(60_000);
    const convId = "conv_bbbbbbbbbbbb2222";
    const otherConvId = "conv_cccccccccccc3333";
    const tab1 = mgr.addSubscriber(convId, "usr_alice");
    const tab2 = mgr.addSubscriber(convId, "usr_alice");
    const otherConv = mgr.addSubscriber(otherConvId, "usr_alice");

    mgr.publishEvent(convId, {
      seq: 7,
      type: "text.delta",
      data: { runId: "run_1", text: "hello" },
    });

    const [t1Raw, t2Raw, oRaw] = await Promise.all([
      drainImmediately(tab1.stream),
      drainImmediately(tab2.stream),
      drainImmediately(otherConv.stream),
    ]);
    const t1 = broadcastFrames(t1Raw);
    const t2 = broadcastFrames(t2Raw);

    expect(t1.length).toBe(1);
    expect(t1[0]).toContain("event: text.delta");
    expect(t1[0]).toContain("id: 7");
    expect(t1[0]).toContain('"text":"hello"');
    expect(t2.length).toBe(1);
    expect(broadcastFrames(oRaw).length).toBe(0);

    mgr.stop();
  });

  test("a cancelled subscriber is reaped, not delivered to", async () => {
    const mgr = new ConversationEventManager(60_000);
    const convId = "conv_aabbccddeeff7777";

    const { stream } = mgr.addSubscriber(convId, "usr_alice");
    // Cancelling the consumer side fires the stream's `cancel`
    // callback, which removes the subscriber. The next publish
    // must not throw against a closed controller.
    await stream.cancel();
    expect(mgr.subscriberCount).toBe(0);
    mgr.publishEvent(convId, { seq: 1, type: "cancelled", data: {} });

    mgr.stop();
  });
});
