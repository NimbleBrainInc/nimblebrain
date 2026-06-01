/**
 * React hook for subscribing to per-conversation SSE events.
 *
 * Stage 1: conversations are single-owner; the broadcast still fires
 * server-side so this subscription is the same-user cross-tab sync
 * path (one user, multiple browser tabs/devices on the same
 * conversation). Stage 4 reintroduces multi-user sharing and this
 * hook's audience widens.
 *
 * Transport ownership lives in the keyed singleton at
 * `api/conversation-events-client.ts`. This hook is a thin subscriber:
 * the first mount for a given `conversationId` opens the underlying
 * connection, additional mounts share it, and the last unmount tears
 * it down. On reconnect, the hook fires `onReconnect` so the caller can
 * reload the full conversation to catch missed messages.
 */

import { useEffect, useRef } from "react";
import { subscribeConversation } from "../api/conversation-events-client";

export interface ConversationEventCallbacks {
  /** A user message arrived from another participant. */
  onRemoteUserMessage: (data: {
    userId: string;
    displayName: string;
    content: string;
    timestamp: string;
  }) => void;
  /** A streaming event arrived from the assistant (responding to another user's message). */
  onRemoteStreamEvent: (type: string, data: unknown) => void;
  /** Connection was re-established — reload the conversation to catch missed messages. */
  onReconnect: () => void;
}

export function useConversationEvents(
  conversationId: string | null,
  callbacks: ConversationEventCallbacks,
): void {
  // Keep callbacks in a ref so consumers can re-render without churning
  // the subscription. The effect re-runs only on conversationId change.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!conversationId) return;

    const unsubscribe = subscribeConversation(conversationId, {
      onEvent: (type, data) => {
        if (type === "user.message") {
          callbacksRef.current.onRemoteUserMessage(
            data as {
              userId: string;
              displayName: string;
              content: string;
              timestamp: string;
            },
          );
        } else if (type === "heartbeat") {
          // Ignore heartbeats — they're keep-alive frames, not chat events.
        } else {
          // text.delta, tool.start, tool.done, llm.done, done
          callbacksRef.current.onRemoteStreamEvent(type, data);
        }
      },
      onReconnect: () => {
        callbacksRef.current.onReconnect();
      },
    });

    return unsubscribe;
  }, [conversationId]);
}
