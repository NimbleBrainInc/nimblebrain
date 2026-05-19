import type { ConversationEventManager } from "../api/conversation-events.ts";
import type { ConversationStore } from "../conversation/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";

// ── Types ─────────────────────────────────────────────────────────

/**
 * Context the conversation-permission helper needs. Stage 1: this is a
 * single helper (`canManageConversation`) used by `workspace-mgmt-tools.ts`
 * for conversation operations that survive the share/unshare/participant
 * purge — currently nothing in production, retained for the typed surface.
 *
 * The `createManageConversationTool` factory + the four action handlers
 * (`handleShareConversation`, `handleUnshareConversation`,
 * `handleAddParticipant`, `handleRemoveParticipant`) were removed as
 * part of Stage 1's schema purge. Sharing returns in Stage 4 with
 * policy-gated primitives.
 */
export interface ManageConversationContext {
  /** Returns the requesting user's identity, or null if unauthenticated. */
  getIdentity: () => UserIdentity | null;
  conversationStore: ConversationStore;
  workspaceStore: WorkspaceStore;
  /** Per-conversation event manager — kept on the type for symmetry. */
  conversationEventManager?: ConversationEventManager;
}

// ── Permission helper ────────────────────────────────────────────

/**
 * Check if the requesting user can manage a conversation.
 *
 * Stage 1: single-owner. Only the conversation owner can manage. The
 * previous workspace-admin override is gone — Stage 4 reintroduces it
 * with explicit policy.
 */
export async function canManageConversation(
  ctx: ManageConversationContext,
  conversationId: string,
  identity: UserIdentity,
): Promise<{ allowed: boolean; reason?: string }> {
  const conversation = await ctx.conversationStore.load(conversationId);
  if (!conversation) {
    return { allowed: false, reason: `Conversation not found: ${conversationId}` };
  }

  if (conversation.ownerId === identity.id) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: "Permission denied. Only the conversation owner can manage this conversation.",
  };
}
