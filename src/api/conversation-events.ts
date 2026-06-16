/**
 * Per-conversation SSE event manager.
 *
 * Tracks subscribers per conversation and broadcasts chat events
 * (text.delta, tool.start, tool.done, llm.done, done, user.message)
 * only to authorized participants of that specific conversation.
 *
 * Separate from SseEventManager which handles workspace-level events.
 */

import { log } from "../cli/log.ts";
import type { BufferedRunEvent } from "../runtime/run-bus.ts";

/** A subscriber watching a specific conversation's events. */
interface ConversationSubscriber {
  id: string;
  userId: string;
  conversationId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

const encoder = new TextEncoder();

/** Format an SSE frame. `seq`, when present, is sent as the `id:` line so a
 *  reconnecting viewer can resume from its last-seen sequence number. */
function frame(eventType: string, data: unknown, seq?: number): Uint8Array {
  const idLine = seq != null ? `id: ${seq}\n` : "";
  return encoder.encode(`event: ${eventType}\n${idLine}data: ${JSON.stringify(data)}\n\n`);
}

export class ConversationEventManager {
  private subscribers = new Map<string, ConversationSubscriber>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs: number;

  constructor(heartbeatIntervalMs = 30_000) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
  }

  /** Start the heartbeat timer. */
  start(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.broadcastToAll("heartbeat", {
        timestamp: new Date().toISOString(),
      });
    }, this.heartbeatIntervalMs);
  }

  /** Stop the heartbeat timer and close all subscribers. */
  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const sub of this.subscribers.values()) {
      this.closeSub(sub);
    }
    this.subscribers.clear();
  }

  /** Number of active subscribers across all conversations. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Subscribe a user to a conversation's event stream.
   *
   * Returns both the ReadableStream (the Response body) and the
   * server-generated `subscriberId` for the new subscription. The id
   * is also written into the stream as the first frame
   * (`event: subscribed`) so the consumer can learn it from the SSE
   * payload alone — clients that originate a `/v1/chat/stream` POST
   * for the same conversation pass that id back as the
   * `X-Origin-Subscriber-Id` header. The chat-stream handler forwards
   * the id to `broadcastToConversation`'s `excludeSubscriberId`, which
   * prevents the broadcast from echoing the same event back to the
   * sender's own subscription (which is otherwise indistinguishable
   * from peer-tab subscriptions of the same user post-Stage-1).
   */
  addSubscriber(
    conversationId: string,
    userId: string,
    replay?: BufferedRunEvent[],
    meta?: { isActive: boolean; activeSeq: number },
  ): { stream: ReadableStream<Uint8Array>; subscriberId: string } {
    const id = crypto.randomUUID();
    let sub: ConversationSubscriber;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        sub = { id, userId, conversationId, controller, closed: false };
        // The subscribed frame tells the client whether a turn is in flight
        // (so it can trim a stale in-flight turn from disk history before the
        // RunBus replay rebuilds it) and its current seq.
        controller.enqueue(
          frame("subscribed", {
            subscriberId: id,
            isActive: meta?.isActive ?? false,
            activeSeq: meta?.activeSeq ?? 0,
          }),
        );
        // Replay the in-flight turn (if any) BEFORE registering for live
        // fan-out. start() runs synchronously and we add to the subscribers
        // map only after replaying, so no live event can interleave ahead of
        // the replay — viewers never see out-of-order deltas.
        //
        // This ordering is load-bearing and depends on start() being
        // SYNCHRONOUS from the replay snapshot through subscribers.set(). Do
        // NOT make this callback async or `await` anything between here and the
        // set() below: an await would yield the event loop, letting a live
        // publish slip into the gap — fanned out to an unregistered subscriber
        // (lost) or arriving before the replay it should follow (out of order).
        if (replay) {
          for (const e of replay) controller.enqueue(frame(e.type, e.data, e.seq));
        }
        this.subscribers.set(id, sub);
      },
      cancel: () => {
        this.removeSubscriber(id);
      },
    });

    return { stream, subscriberId: id };
  }

  /**
   * Fan out a live run event (with its sequence number) to every subscriber
   * of the conversation. The seq lets viewers de-duplicate against replay and
   * resume after a reconnect.
   */
  publishEvent(conversationId: string, event: BufferedRunEvent): void {
    const encoded = frame(event.type, event.data, event.seq);
    for (const [id, sub] of this.subscribers) {
      if (sub.closed) {
        this.subscribers.delete(id);
        continue;
      }
      if (sub.conversationId !== conversationId) continue;
      try {
        sub.controller.enqueue(encoded);
      } catch (err) {
        log.warn("[conversation-events] SSE write failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.closeSub(sub);
        this.subscribers.delete(id);
      }
    }
  }

  /** Remove a specific subscriber. */
  removeSubscriber(subscriberId: string): void {
    const sub = this.subscribers.get(subscriberId);
    if (sub) {
      this.closeSub(sub);
      this.subscribers.delete(subscriberId);
    }
  }

  /**
   * Broadcast an event to all subscribers of a specific conversation.
   *
   * Conversations are single-owner (Stage 1): every subscriber is the same
   * user on another tab/device. The exclusion key is the **subscriber id**,
   * not `userId` — filtering by `userId` would skip every tab; not filtering
   * double-delivers to the sender (it receives via both `/v1/chat/stream` and
   * its own `/v1/conversations/:id/events` subscription). The sender passes
   * its conv-events subscriber id as `excludeSubscriberId` so its own
   * subscription is skipped while peer tabs still receive. (Stage 4
   * multi-participant semantics will need explicit policy gates here.)
   *
   * Seq-less: unlike {@link publishEvent} (the RunBus path), these frames carry
   * no `id:` sequence. A seq-tracking `conversation-stream` viewer applies them
   * live but can't replay/resume them. Only `/v1/chat` + `/v1/chat/stream` use
   * this; the web shell is RunBus-only.
   *
   * @param conversationId - Target conversation
   * @param eventType - SSE event type (e.g. "text.delta", "user.message")
   * @param data - Event data payload
   * @param excludeSubscriberId - Optional subscriber id to skip
   *   (typically the sender's own, to prevent self-echo).
   */
  broadcastToConversation(
    conversationId: string,
    eventType: string,
    data: Record<string, unknown>,
    excludeSubscriberId?: string,
  ): void {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    const encoded = encoder.encode(message);

    for (const [id, sub] of this.subscribers) {
      if (sub.closed) {
        this.subscribers.delete(id);
        continue;
      }
      if (sub.conversationId !== conversationId) continue;
      if (excludeSubscriberId && sub.id === excludeSubscriberId) continue;

      try {
        sub.controller.enqueue(encoded);
      } catch (err) {
        log.warn("[conversation-events] SSE write failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.closeSub(sub);
        this.subscribers.delete(id);
      }
    }
  }

  /** Send heartbeat to all subscribers. */
  private broadcastToAll(eventType: string, data: Record<string, unknown>): void {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    const encoded = encoder.encode(message);

    for (const [id, sub] of this.subscribers) {
      if (sub.closed) {
        this.subscribers.delete(id);
        continue;
      }
      try {
        sub.controller.enqueue(encoded);
      } catch (err) {
        log.warn("[conversation-events] SSE broadcast write failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.closeSub(sub);
        this.subscribers.delete(id);
      }
    }
  }

  private closeSub(sub: ConversationSubscriber): void {
    if (sub.closed) return;
    sub.closed = true;
    try {
      sub.controller.close();
    } catch {
      // Already closed
    }
  }
}
