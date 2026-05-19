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
   * Returns the ReadableStream to be used as the Response body.
   */
  addSubscriber(conversationId: string, userId: string): ReadableStream<Uint8Array> {
    const id = crypto.randomUUID();
    let sub: ConversationSubscriber;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        sub = { id, userId, conversationId, controller, closed: false };
        this.subscribers.set(id, sub);
      },
      cancel: () => {
        this.removeSubscriber(id);
      },
    });

    return stream;
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
   * tab/device. Pre-Stage-1 this method took an `excludeUserId` to
   * avoid echoing back to the sender, but with single-owner that
   * filter would skip *every* subscriber — the recipient set is
   * always the owner, including the sender's other tabs. The
   * sender's own tab gets its events from the `/v1/chat/stream`
   * response it initiated; the broadcast feeds peer tabs.
   *
   * Stage 4 will reintroduce multi-participant semantics with
   * explicit policy gates; until then, no caller-side filtering.
   *
   * @param conversationId - Target conversation
   * @param eventType - SSE event type (e.g. "text.delta", "user.message")
   * @param data - Event data payload
   */
  broadcastToConversation(
    conversationId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): void {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    const encoded = encoder.encode(message);

    for (const [id, sub] of this.subscribers) {
      if (sub.closed) {
        this.subscribers.delete(id);
        continue;
      }
      if (sub.conversationId !== conversationId) continue;

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
