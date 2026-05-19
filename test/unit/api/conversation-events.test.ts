/**
 * Regression coverage for the per-conversation SSE broadcast.
 *
 * Stage 1 single-owner: every legitimate subscriber to a given
 * conversation is the same user (the owner). Pre-Stage-1 the sender's
 * `identity.id` was passed as `excludeUserId` to prevent echoing back —
 * that filter is gone (issue: it zeroed out the recipient set every
 * time, so cross-tab sync never delivered). The sender's own tab gets
 * events from the `/v1/chat/stream` response it initiated; the
 * broadcast feeds peer tabs.
 */

import { describe, expect, test } from "bun:test";
import { ConversationEventManager } from "../../../src/api/conversation-events.ts";

const decoder = new TextDecoder();

/**
 * Drain everything currently queued on the ReadableStream into an
 * array of decoded chunks. Each `read()` is raced against a short
 * timer so we stop after the queued chunks are drained instead of
 * waiting for the stream to close. `setTimeout(0)` after a Promise
 * microtask lets any already-enqueued chunk surface first, while
 * still bailing on a stream with no pending data.
 */
async function drainImmediately(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  while (true) {
    const next = reader.read();
    const settled = await Promise.race([
      next.then((r) => ({ kind: "read" as const, r })),
      new Promise<{ kind: "tick" }>((resolve) =>
        setTimeout(() => resolve({ kind: "tick" }), 10),
      ),
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

describe("ConversationEventManager.broadcastToConversation", () => {
  test("delivers to every same-conversation subscriber (no userId exclusion)", async () => {
    // Stage 1 single-owner: the sender's other tabs all carry the
    // same userId. Pre-fix, passing the sender's id as `excludeUserId`
    // zeroed the recipient set. Post-fix, the broadcast fans out to
    // every subscriber on the conversation regardless of userId.
    const mgr = new ConversationEventManager(60_000);

    const convId = "conv_aaaaaaaaaaaa1111";
    const otherConvId = "conv_bbbbbbbbbbbb2222";
    const tab1 = mgr.addSubscriber(convId, "usr_alice");
    const tab2 = mgr.addSubscriber(convId, "usr_alice");
    const peerOtherConv = mgr.addSubscriber(otherConvId, "usr_alice");

    mgr.broadcastToConversation(convId, "text.delta", { delta: "hello" });

    const [t1, t2, other] = await Promise.all([
      drainImmediately(tab1),
      drainImmediately(tab2),
      drainImmediately(peerOtherConv),
    ]);

    // Both tabs on the target conversation received the event.
    expect(t1.length).toBe(1);
    expect(t1[0]).toContain('event: text.delta');
    expect(t1[0]).toContain('"delta":"hello"');
    expect(t2.length).toBe(1);
    expect(t2[0]).toContain('event: text.delta');

    // The subscriber on a different conversation got nothing.
    expect(other.length).toBe(0);

    mgr.stop();
  });

  test("scoped strictly to conversationId — no cross-conversation bleed", async () => {
    const mgr = new ConversationEventManager(60_000);
    const target = "conv_cccccccccccc1111";
    const decoy = "conv_dddddddddddd2222";
    const targetSub = mgr.addSubscriber(target, "usr_alice");
    const decoySub = mgr.addSubscriber(decoy, "usr_alice");

    mgr.broadcastToConversation(target, "user.message", { content: "ping" });

    const [t, d] = await Promise.all([drainImmediately(targetSub), drainImmediately(decoySub)]);
    expect(t.length).toBe(1);
    expect(d.length).toBe(0);

    mgr.stop();
  });

  test("a closed subscriber is reaped, not delivered to", async () => {
    const mgr = new ConversationEventManager(60_000);
    const convId = "conv_eeeeeeeeeeee1111";

    const stream = mgr.addSubscriber(convId, "usr_alice");
    // Cancelling the consumer side fires the stream's `cancel` callback,
    // which `removeSubscriber`s us. After that the broadcast should
    // skip this subscriber cleanly.
    await stream.cancel();

    // No subscribers remain on this conversation.
    expect(mgr.subscriberCount).toBe(0);

    // Broadcasting now is a no-op — would throw if we tried to enqueue
    // onto the closed controller, so reaching this line is the assertion.
    mgr.broadcastToConversation(convId, "done", { ok: true });

    mgr.stop();
  });
});
