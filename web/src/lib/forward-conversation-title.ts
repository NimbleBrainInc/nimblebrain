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
 * Targets the conversations iframe by its `data-app` attribute. That attribute
 * is set by `SlotRenderer` to the placement's *serverName* (`conversations`) —
 * NOT the SDK SynapseProvider app name (`@nimblebraininc/conversations`). Using
 * the SDK name matches zero iframes and the title silently never reaches the
 * list (only a refresh, which refetches from disk, surfaces it). This is the
 * same `data-app === serverName` contract `useDataSync` relies on.
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
    // (matches useDataSync's path — same constraint).
    iframe.contentWindow?.postMessage(message, "*");
  }
}
