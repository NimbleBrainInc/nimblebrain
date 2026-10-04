/**
 * Per-conversation SSE event manager.
 *
 * Tracks subscribers per conversation and fans out the RunBus's sequenced
 * turn events only to the owner's subscriptions on that conversation.
 *
 * Separate from SseEventManager which handles workspace-level events.
 */

import { log } from "../observability/log.ts";
import type { BufferedRunEvent } from "../runtime/run-bus.ts";
import type { HeartbeatEvent, SubscribedEvent } from "./schemas/events.ts";

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
   * Returns the ReadableStream (the Response body). Its first frame is
   * `event: subscribed`.
   */
  addSubscriber(
    conversationId: string,
    userId: string,
    replay?: BufferedRunEvent[],
    meta?: { isActive: boolean; activeSeq: number },
  ): { stream: ReadableStream<Uint8Array> } {
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
            isActive: meta?.isActive ?? false,
            activeSeq: meta?.activeSeq ?? 0,
          } satisfies SubscribedEvent),
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

    return { stream };
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

  /** Send heartbeat to all subscribers. */
  private broadcastToAll(eventType: "heartbeat", data: HeartbeatEvent): void {
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
