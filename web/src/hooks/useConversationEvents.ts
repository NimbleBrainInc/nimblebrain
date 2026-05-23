/**
 * React hook for subscribing to per-conversation SSE events.
 *
 * Stage 1: conversations are single-owner; the broadcast still fires
 * server-side so this subscription is the same-user cross-tab sync
 * path (one user, multiple browser tabs/devices on the same
 * conversation). Stage 4 reintroduces multi-user sharing and this
 * hook's audience widens.
 *
 * Disconnects on cleanup or when the conversation changes. On
 * reconnect, triggers a full conversation reload to catch missed
 * messages.
 */

import { useEffect, useRef } from "react";
import { getAuthToken } from "../api/client";
import { type ConversationSseConnection, connectConversationEvents } from "../api/conversation-sse";

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
  // Keep callbacks in a ref so we don't reconnect on every render
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    // Subscribe whenever a conversation is open — same-user cross-tab
    // sync (and, post-Stage-4, multi-user sharing).
    if (!conversationId) return;

    const token = getAuthToken();
    let connection: ConversationSseConnection | null = null;

    connection = connectConversationEvents({
      conversationId,
      token: token ?? undefined,
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
          // Ignore heartbeats
        } else {
          // text.delta, tool.start, tool.done, llm.done, done
          callbacksRef.current.onRemoteStreamEvent(type, data);
        }
      },
      onReconnect: () => {
        callbacksRef.current.onReconnect();
      },
      onError: (err) => {
        console.warn("[conversation-sse] Error:", err.message);
      },
    });

    return () => {
      connection?.close();
    };
  }, [conversationId]);
}
