/**
 * URI scheme for conversations: `conversation://<id>`.
 *
 * A conversation is kernel state shown in the shell's own chat panel, not in
 * an app, so the host answers this scheme itself when a view or the agent asks
 * to open one (`nb__open_app`, ADR-0052). Like `files://`, the URI is bare: the
 * workspace comes from the request and the owner from its identity, and a
 * conversation id outside the caller's own partition is refused as not found.
 */

export const CONVERSATION_URI_SCHEME = "conversation";
const CONVERSATION_URI_PREFIX = `${CONVERSATION_URI_SCHEME}://`;

/** Returns the conversation id for a `conversation://` URI, or `null` for any other scheme. */
export function uriToConversationId(uri: string): string | null {
  if (!uri.startsWith(CONVERSATION_URI_PREFIX)) return null;
  return uri.slice(CONVERSATION_URI_PREFIX.length);
}
