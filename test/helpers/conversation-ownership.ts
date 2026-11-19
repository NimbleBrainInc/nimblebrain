import { CONVERSATION_ID_RE } from "../../src/conversation/types.ts";
import { ConversationNotFoundError } from "../../src/runtime/errors.ts";

/** A stored conversation: the workspace it lives in, its owner, and its id. */
export interface StoredConversation {
  wsId: string;
  ownerId: string;
  conversationId: string;
}

/**
 * `Runtime.assertConversationInWorkspace` over a fixed set of conversations,
 * with the runtime's answers: a malformed id, another owner's conversation, one
 * stored in another workspace, and an unknown one all throw
 * `ConversationNotFoundError`.
 */
export function assertConversationInWorkspaceOver(
  conversations: StoredConversation[],
): (conversationId: string, wsId: string, ownerId: string) => void {
  return (conversationId, wsId, ownerId) => {
    const found = conversations.some(
      (c) => c.conversationId === conversationId && c.wsId === wsId && c.ownerId === ownerId,
    );
    if (!CONVERSATION_ID_RE.test(conversationId) || !found) {
      throw new ConversationNotFoundError(conversationId, wsId);
    }
  };
}
