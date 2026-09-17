/**
 * Forward a live `conversation.title` SSE event to the conversations-list
 * iframe via postMessage.
 *
 * The conversations app's Dashboard listens for `synapse/conversation-title`
 * and patches the matching row's title in-place. Sending the
 * (conversationId, title) tuple directly is one postMessage and an in-place
 * state update, where a list refetch would reread every row.
 *
 * Targets the conversations iframe by its `data-app` attribute. That attribute
 * is set by `SlotRenderer` to the placement's *serverName* (`conversations`) —
 * NOT the SDK SynapseProvider app name (`@nimblebraininc/conversations`). Using
 * the SDK name matches zero iframes and the title silently never reaches the
 * list (only a refresh, which refetches from disk, surfaces it). This is the
 * same `data-app === serverName` contract the server-notification relay
 * (`useServerNotificationRelay`) relies on.
 *
 * Unrelated iframes never see the message. No-op when the conversations panel
 * isn't currently mounted — the next mount loads from disk where the title is
 * already persisted, so there's no race.
 *
 * @param conversationId Conversation whose title was just generated.
 * @param title          The generated title.
 */
const CONVERSATIONS_APP = "conversations";

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
    // (the server-notification relay has the same constraint).
    iframe.contentWindow?.postMessage(message, "*");
  }
}
