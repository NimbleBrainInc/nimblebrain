/**
 * Per-conversation `subscriberId` registry.
 *
 * The server-issued subscriber id arrives in the first SSE frame
 * (`event: subscribed`) once a conversation event stream opens. We
 * stash it here so the chat-stream POST path can pick it up via
 * `getConversationSubscriberId(convId)` and forward it as
 * `X-Origin-Subscriber-Id` — that makes the broadcast skip this
 * tab's own conv-events subscription and prevents the sender from
 * double-handling every event (once via the chat-stream HTTP
 * response, once via the broadcast hitting its own subscription).
 *
 * Cleared on stream cancel / close to avoid stale ids leaking into
 * a future stream attempt for the same conv.
 *
 * This registry lives in its own module — not in `conversation-sse.ts` —
 * so `client.ts` can read subscriber ids without importing
 * `conversation-sse.ts`, which imports `refreshSession` back from
 * `client.ts`. That was a circular import (`client ↔ conversation-sse`);
 * Bun resolves cycles in module-evaluation order, which is non-deterministic
 * under the parallel test runner and intermittently surfaced client.ts's
 * named exports as "not found". Holding the shared state here breaks the cycle:
 * `client.ts` and `conversation-sse.ts` both depend only on this leaf module.
 */
const conversationSubscriberIds = new Map<string, string>();

export function getConversationSubscriberId(conversationId: string): string | undefined {
  return conversationSubscriberIds.get(conversationId);
}

export function setConversationSubscriberId(conversationId: string, subscriberId: string): void {
  conversationSubscriberIds.set(conversationId, subscriberId);
}

export function clearConversationSubscriberId(conversationId: string): void {
  conversationSubscriberIds.delete(conversationId);
}
