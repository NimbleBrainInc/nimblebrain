// ---------------------------------------------------------------------------
// Per-conversation Event Stream — keyed singleton client
//
// One `GET /v1/conversations/:id/events` SSE connection per ACTIVE
// conversation, fanned out to many subscribers via `subscribeConversation`.
// Same singleton pattern as `events-client.ts`, but keyed by
// `conversationId` and ref-counted: when the last subscriber for a
// conversation unsubscribes, that conversation's connection closes.
// (Conversations are mounted / unmounted as the user navigates; the
// workspace stream is tab-life because it always has a consumer.)
//
// Why this exists. Today only `ChatContext.tsx:170` calls
// `useConversationEvents`, so it's a singleton by coincidence. The
// moment a second component starts subscribing — a preview pane, a
// notification surface, an embedded view — the per-component
// connectConversationEvents pattern would silently duplicate the
// connection per conversation. Building the singleton up-front prevents
// tomorrow's regression at zero ongoing cost.
//
// Auth lifecycle: identity rotation closes every active conversation
// stream. Existing subscribers may re-subscribe after navigation; we
// don't auto-rebuild like the workspace stream because conversation
// streams are user-driven (mounted by ChatContext on conversation
// focus), not always-on substrate.
// ---------------------------------------------------------------------------

import { addAuthLifecycleHandler, getAuthToken } from "./client";
import { type ConversationSseConnection, connectConversationEvents } from "./conversation-sse";

type EventHandler = (type: string, data: unknown) => void;
type ReconnectHandler = () => void;

interface ConversationEntry {
  connection: ConversationSseConnection;
  eventHandlers: Set<EventHandler>;
  reconnectHandlers: Set<ReconnectHandler>;
}

const entries = new Map<string, ConversationEntry>();

function ensureEntry(conversationId: string): ConversationEntry {
  const existing = entries.get(conversationId);
  if (existing) return existing;

  // Create the entry first so the `onEvent` / `onReconnect` closures
  // below can reference it directly. Closing over `entries.get(...)`
  // in each callback would re-look-up every event.
  const entry: ConversationEntry = {
    connection: null as unknown as ConversationSseConnection,
    eventHandlers: new Set(),
    reconnectHandlers: new Set(),
  };
  entries.set(conversationId, entry);

  entry.connection = connectConversationEvents({
    conversationId,
    token: getAuthToken() ?? undefined,
    onEvent: (type, data) => {
      for (const h of entry.eventHandlers) {
        try {
          h(type, data);
        } catch (err) {
          console.warn("[conv-events-client] event handler threw:", err);
        }
      }
    },
    onReconnect: () => {
      for (const h of entry.reconnectHandlers) {
        try {
          h();
        } catch (err) {
          console.warn("[conv-events-client] reconnect handler threw:", err);
        }
      }
    },
    // Surface unrecoverable transport errors (403 after participant
    // removal, persistent auth failure) the way the pre-singleton hook
    // did — silent failure makes a dying conversation stream
    // undiagnosable. Drop the entry so a later subscribe re-attempts.
    onError: (err) => {
      console.warn(`[conv-events-client] stream error for ${conversationId}:`, err.message);
      entries.delete(conversationId);
    },
  });

  return entry;
}

function closeEntry(conversationId: string): void {
  const entry = entries.get(conversationId);
  if (!entry) return;
  entries.delete(conversationId);
  try {
    entry.connection.close();
  } catch (err) {
    // The transport already swallows close errors internally; logging
    // here just in case a future implementation throws.
    console.warn("[conv-events-client] close threw for", conversationId, err);
  }
}

/**
 * Close every active conversation stream. Used by the auth lifecycle
 * handler below and by `pagehide` cleanup in `App.tsx`. Idempotent.
 */
export function closeAllConversationEvents(): void {
  for (const id of Array.from(entries.keys())) {
    closeEntry(id);
  }
}

// Identity rotation drops every conversation stream. Unlike the
// workspace events client, we don't auto-rebuild — conversation streams
// are user-driven (mounted by ChatContext when a conversation is in
// focus), so the next conversation focus will open a fresh stream
// under the new identity.
const authLifecycleHandler = closeAllConversationEvents;
addAuthLifecycleHandler(authLifecycleHandler);

export interface ConversationSubscription {
  /** Fires for every SSE event on this conversation's stream. */
  onEvent: EventHandler;
  /** Fires after a reconnect — caller should reload missed messages. */
  onReconnect?: ReconnectHandler;
}

/**
 * Subscribe to a conversation's SSE event stream. The first subscribe
 * for a given `conversationId` opens the underlying connection; the
 * last unsubscribe closes it. Ref-counted per conversation.
 *
 * Returns an unsubscribe function. Calling it removes this subscription
 * and, if no subscriptions remain for the conversation, tears down the
 * connection.
 */
export function subscribeConversation(
  conversationId: string,
  sub: ConversationSubscription,
): () => void {
  const entry = ensureEntry(conversationId);
  entry.eventHandlers.add(sub.onEvent);
  if (sub.onReconnect) entry.reconnectHandlers.add(sub.onReconnect);

  return () => {
    const current = entries.get(conversationId);
    if (!current) return;
    current.eventHandlers.delete(sub.onEvent);
    if (sub.onReconnect) current.reconnectHandlers.delete(sub.onReconnect);
    if (current.eventHandlers.size === 0 && current.reconnectHandlers.size === 0) {
      closeEntry(conversationId);
    }
  };
}

// ── Test seams ───────────────────────────────────────────────────────

export const __internal__ = {
  hasConnection(conversationId: string): boolean {
    return entries.has(conversationId);
  },
  connectionCount(): number {
    return entries.size;
  },
  resetForTest(): void {
    closeAllConversationEvents();
    // Other test files may have cleared the global lifecycle Set;
    // re-register idempotently. See events-client.ts for the same
    // pattern + rationale.
    addAuthLifecycleHandler(authLifecycleHandler);
  },
};
