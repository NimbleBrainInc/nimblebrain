/**
 * Forward a live `conversation.title` SSE event to the conversations-list
 * iframe via postMessage.
 *
 * The conversations bundle's Dashboard listens for `synapse/conversation-title`
 * and patches the matching row's title in-place. This is the cheap path: a
 * full `data.changed` would force a list refetch, which is what the runtime
 * used to fire on title resolve. Sending the (conversationId, title) tuple
 * directly is one postMessage and an in-place state update.
 *
 * Targets only iframes whose `data-app` matches the conversations bundle
 * name (`@nimblebraininc/conversations`). Unrelated iframes never see the
 * message. No-op when the conversations panel isn't currently mounted —
 * the next mount loads from disk where the title is already persisted, so
 * there's no race.
 *
 * @param conversationId Conversation whose title was just generated.
 * @param title          The generated title.
 */
const CONVERSATIONS_APP = "@nimblebraininc/conversations";

export function forwardConversationTitleToIframes(conversationId: string, title: string): void {
  const iframes = document.querySelectorAll<HTMLIFrameElement>(
    `iframe[data-app="${CONVERSATIONS_APP}"]`,
  );
  if (iframes.length === 0) return;
  const message = {
    jsonrpc: "2.0",
    method: "synapse/conversation-title",
    params: { conversationId, title },
  };
  for (const iframe of iframes) {
    // Srcdoc iframes have the opaque "null" origin; targetOrigin must be "*"
    // (matches useDataSync's path — same constraint).
    iframe.contentWindow?.postMessage(message, "*");
  }
}
