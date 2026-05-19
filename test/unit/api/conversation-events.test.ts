/**
 * Regression coverage for the per-conversation SSE broadcast.
 *
 * The exclusion key is the **subscriber id**, not the userId:
 *
 * - Round-3 (`identity.id` as `excludeUserId`) skipped *every*
 *   subscriber because Stage 1 single-owner means every subscriber on
 *   one conversation is the same user — cross-tab sync never fired.
 * - Round-4 (no exclusion at all) double-delivered on the sender's
 *   own tab: the chat-stream HTTP response and the conv-events SSE
 *   subscription on the same tab both processed every event.
 *
 * The right key is the subscriber id: `addSubscriber` returns a
 * unique id with the stream; the client passes that id back as
 * `X-Origin-Subscriber-Id` on its chat-stream POST; the handler
 * forwards it to `broadcastToConversation` as `excludeSubscriberId`.
 * The sender's own subscription is skipped while peer tabs (same
 * user, different subscriber id) receive normally.
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

/** Skip the initial `event: subscribed` frame the manager emits on subscribe. */
function broadcastFrames(chunks: string[]): string[] {
  return chunks.filter((c) => !c.includes("event: subscribed"));
}

describe("ConversationEventManager", () => {
  test("addSubscriber emits an initial `event: subscribed` frame with the new id", async () => {
    const mgr = new ConversationEventManager(60_000);
    const convId = "conv_aaaaaaaaaaaa1111";

    const { stream, subscriberId } = mgr.addSubscriber(convId, "usr_alice");
    expect(subscriberId).toMatch(/^[0-9a-f-]{36}$/);

    const chunks = await drainImmediately(stream);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const subscribed = chunks.find((c) => c.startsWith("event: subscribed"));
    expect(subscribed).toBeDefined();
    expect(subscribed).toContain(`"subscriberId":"${subscriberId}"`);

    mgr.stop();
  });

  test("broadcast without excludeSubscriberId fans out to every subscriber on the conversation", async () => {
    const mgr = new ConversationEventManager(60_000);
    const convId = "conv_bbbbbbbbbbbb2222";
    const otherConvId = "conv_cccccccccccc3333";
    const tab1 = mgr.addSubscriber(convId, "usr_alice");
    const tab2 = mgr.addSubscriber(convId, "usr_alice");
    const otherConv = mgr.addSubscriber(otherConvId, "usr_alice");

    mgr.broadcastToConversation(convId, "text.delta", { delta: "hello" });

    const [t1Raw, t2Raw, oRaw] = await Promise.all([
      drainImmediately(tab1.stream),
      drainImmediately(tab2.stream),
      drainImmediately(otherConv.stream),
    ]);
    const t1 = broadcastFrames(t1Raw);
    const t2 = broadcastFrames(t2Raw);
    const other = broadcastFrames(oRaw);

    expect(t1.length).toBe(1);
    expect(t1[0]).toContain("event: text.delta");
    expect(t1[0]).toContain('"delta":"hello"');
    expect(t2.length).toBe(1);
    expect(t2[0]).toContain("event: text.delta");
    expect(other.length).toBe(0);

    mgr.stop();
  });

  test("broadcast with excludeSubscriberId skips the sender but still reaches peer tabs (same user)", async () => {
    // The load-bearing test: the sender's tab and a peer tab belong
    // to the SAME user. Pre-fix round-3 (filter on userId) would
    // skip both; pre-fix round-4 (no filter) would deliver to both,
    // doubling on the sender. The subscriber-id filter delivers to
    // peer only.
    const mgr = new ConversationEventManager(60_000);
    const convId = "conv_dddddddddddd4444";
    const sender = mgr.addSubscriber(convId, "usr_alice");
    const peer = mgr.addSubscriber(convId, "usr_alice");

    mgr.broadcastToConversation(
      convId,
      "text.delta",
      { delta: "from chat-stream" },
      sender.subscriberId,
    );

    const [senderRaw, peerRaw] = await Promise.all([
      drainImmediately(sender.stream),
      drainImmediately(peer.stream),
    ]);
    expect(broadcastFrames(senderRaw).length).toBe(0);
    const peerFrames = broadcastFrames(peerRaw);
    expect(peerFrames.length).toBe(1);
    expect(peerFrames[0]).toContain('"delta":"from chat-stream"');

    mgr.stop();
  });

  test("broadcast is scoped strictly to conversationId", async () => {
    const mgr = new ConversationEventManager(60_000);
    const target = "conv_eeeeeeeeeeee5555";
    const decoy = "conv_ffffffffffff6666";
    const targetSub = mgr.addSubscriber(target, "usr_alice");
    const decoySub = mgr.addSubscriber(decoy, "usr_alice");

    mgr.broadcastToConversation(target, "user.message", { content: "ping" });

    const [t, d] = await Promise.all([
      drainImmediately(targetSub.stream),
      drainImmediately(decoySub.stream),
    ]);
    expect(broadcastFrames(t).length).toBe(1);
    expect(broadcastFrames(d).length).toBe(0);

    mgr.stop();
  });

  test("a cancelled subscriber is reaped, not delivered to", async () => {
    const mgr = new ConversationEventManager(60_000);
    const convId = "conv_aabbccddeeff7777";

    const { stream } = mgr.addSubscriber(convId, "usr_alice");
    // Cancelling the consumer side fires the stream's `cancel`
    // callback, which removes the subscriber. The next broadcast
    // must not throw against a closed controller.
    await stream.cancel();
    expect(mgr.subscriberCount).toBe(0);
    mgr.broadcastToConversation(convId, "done", { ok: true });

    mgr.stop();
  });
});
