/**
 * Per-conversation SSE event manager.
 *
 * Tracks subscribers per conversation and broadcasts chat events
 * (text.delta, tool.start, tool.done, llm.done, done, user.message)
 * only to authorized participants of that specific conversation.
 *
 * Separate from SseEventManager which handles workspace-level events.
 */

/** A subscriber watching a specific conversation's events. */
interface ConversationSubscriber {
  id: string;
  userId: string;
  conversationId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

const encoder = new TextEncoder();

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
  ): { stream: ReadableStream<Uint8Array>; subscriberId: string } {
    const id = crypto.randomUUID();
    let sub: ConversationSubscriber;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        sub = { id, userId, conversationId, controller, closed: false };
        this.subscribers.set(id, sub);
        const subscribedMsg = `event: subscribed\ndata: ${JSON.stringify({ subscriberId: id })}\n\n`;
        controller.enqueue(encoder.encode(subscribedMsg));
      },
      cancel: () => {
        this.removeSubscriber(id);
      },
    });

    return { stream, subscriberId: id };
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
   * Stage 1 single-owner: every legitimate subscriber to a given
   * conversation is the same user (the owner) connected from another
   * tab/device. Filtering on `userId` would skip every subscriber
   * (round-3 had this bug); not filtering at all double-delivers to
   * the sender's own tab (round-4 had this bug — the sender's tab
   * receives via both `/v1/chat/stream` and its own
   * `/v1/conversations/:id/events` subscription).
   *
   * The correct filter key is the **subscriber id**: the sender
   * passes its current conv-events subscriber id as
   * `excludeSubscriberId`, so its own subscription is skipped while
   * peer tabs (different subscriber ids, same userId) still receive.
   *
   * Stage 4 will reintroduce multi-participant semantics with
   * explicit policy gates; until then, this is the only exclusion
   * shape needed.
   *
   * @param conversationId - Target conversation
   * @param eventType - SSE event type (e.g. "text.delta", "user.message")
   * @param data - Event data payload
   * @param excludeSubscriberId - Optional subscriber id to skip
   *   (typically the sender's own subscriber id, to prevent
   *   self-echo on chat-stream-originated broadcasts).
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
        console.warn("[conversation-events] SSE write failed:", err);
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
        console.warn("[conversation-events] SSE broadcast write failed:", err);
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
