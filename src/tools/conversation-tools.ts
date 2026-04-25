import type { ConversationEventManager } from "../api/conversation-events.ts";
import type { ConversationStore } from "../conversation/types.ts";
import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { InProcessTool } from "./in-process-app.ts";

// ── Types ─────────────────────────────────────────────────────────

export interface ManageConversationContext {
  /** Returns the requesting user's identity, or null if unauthenticated. */
  getIdentity: () => UserIdentity | null;
  conversationStore: ConversationStore;
  workspaceStore: WorkspaceStore;
  /** Per-conversation event manager — evict subscribers on participant removal. */
  conversationEventManager?: ConversationEventManager;
}

// ── Permission helpers ───────────────────────────────────────────

/**
 * Check if the requesting user is the conversation owner or
 * a workspace admin for the conversation's workspace.
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

  // Owner can always manage
  if (conversation.ownerId === identity.id) {
    return { allowed: true };
  }

  // Workspace admin can manage conversations in their workspace
  if (conversation.workspaceId) {
    const workspace = await ctx.workspaceStore.get(conversation.workspaceId);
    if (workspace) {
      const member = workspace.members.find((m) => m.userId === identity.id);
      if (member?.role === "admin") {
        return { allowed: true };
      }
    }
  }

  return {
    allowed: false,
    reason:
      "Permission denied. Only the conversation owner or a workspace admin can manage this conversation.",
  };
}

// ── Tool factory ──────────────────────────────────────────────────

export function createManageConversationTool(ctx: ManageConversationContext): InProcessTool {
  return {
    name: "manage_conversation",
    description:
      "Share, unshare, add participants, or remove participants from a conversation. Only the conversation owner or workspace admin can use this tool.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["share", "unshare", "add_participant", "remove_participant"],
          description: "Action to perform on the conversation.",
        },
        conversationId: {
          type: "string",
          description: "The conversation ID to manage.",
        },
        userId: {
          type: "string",
          description: "User ID for add_participant or remove_participant actions.",
        },
      },
      required: ["action", "conversationId"],
    },
    handler: async (input): Promise<ToolResult> => {
      const identity = ctx.getIdentity();
      if (!identity) {
        return {
          content: textContent("Authentication required."),
          isError: true,
        };
      }

      const action = String(input.action);
      const conversationId = String(input.conversationId);

      const check = await canManageConversation(ctx, conversationId, identity);
      if (!check.allowed) {
        return {
          content: textContent(check.reason!),
          isError: false,
        };
      }

      switch (action) {
        case "share":
          return handleShareConversation(ctx, conversationId, identity);
        case "unshare":
          return handleUnshareConversation(ctx, conversationId, identity);
        case "add_participant":
          return handleAddParticipant(ctx, conversationId, input);
        case "remove_participant":
          return handleRemoveParticipant(ctx, conversationId, input);
        default:
          return {
            content: textContent(`Unknown action: ${action}`),
            isError: true,
          };
      }
    },
  };
}

// ── Action handlers ───────────────────────────────────────────────

export async function handleShareConversation(
  ctx: ManageConversationContext,
  conversationId: string,
  identity: UserIdentity,
): Promise<ToolResult> {
  // shareConversation checks ownerId match — use the actual owner for admin callers
  const conv = await ctx.conversationStore.load(conversationId);
  const effectiveOwnerId = conv?.ownerId ?? identity.id;
  const result = await ctx.conversationStore.shareConversation(conversationId, effectiveOwnerId);
  if (!result) {
    return {
      content: textContent(`Failed to share conversation ${conversationId}.`),
      isError: true,
    };
  }
  const data = {
    conversationId: result.id,
    visibility: result.visibility,
    participants: result.participants,
  };
  return {
    content: textContent(`Shared conversation ${result.id}.`),
    structuredContent: data,
    isError: false,
  };
}

export async function handleUnshareConversation(
  ctx: ManageConversationContext,
  conversationId: string,
  identity: UserIdentity,
): Promise<ToolResult> {
  // unshareConversation checks ownerId match — use the actual owner for admin callers
  const conv = await ctx.conversationStore.load(conversationId);
  const effectiveOwnerId = conv?.ownerId ?? identity.id;
  const result = await ctx.conversationStore.unshareConversation(conversationId, effectiveOwnerId);
  if (!result) {
    return {
      content: textContent(`Failed to unshare conversation ${conversationId}.`),
      isError: true,
    };
  }
  // Evict all conversation subscribers — conversation is no longer shared
  ctx.conversationEventManager?.removeAllForConversation(conversationId);
  const data = {
    conversationId: result.id,
    visibility: result.visibility,
    participants: result.participants,
  };
  return {
    content: textContent(`Unshared conversation ${result.id}.`),
    structuredContent: data,
    isError: false,
  };
}

export async function handleAddParticipant(
  ctx: ManageConversationContext,
  conversationId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return {
      content: textContent("userId is required for add_participant."),
      isError: true,
    };
  }

  // Load conversation to get workspace ID
  const conversation = await ctx.conversationStore.load(conversationId);
  if (!conversation) {
    return {
      content: textContent(`Conversation not found: ${conversationId}`),
      isError: true,
    };
  }

  // Validate the target user is a workspace member
  if (conversation.workspaceId) {
    const workspace = await ctx.workspaceStore.get(conversation.workspaceId);
    if (workspace) {
      const isMember = workspace.members.some((m) => m.userId === userId);
      if (!isMember) {
        return {
          content: textContent("User is not a member of this workspace."),
          isError: false,
        };
      }
    }
  }

  const result = await ctx.conversationStore.addParticipant(conversationId, userId);
  if (!result) {
    return {
      content: textContent(`Failed to add participant to conversation ${conversationId}.`),
      isError: true,
    };
  }
  const data = {
    conversationId: result.id,
    participants: result.participants,
  };
  return {
    content: textContent(`Added participant to conversation ${result.id}.`),
    structuredContent: data,
    isError: false,
  };
}

export async function handleRemoveParticipant(
  ctx: ManageConversationContext,
  conversationId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return {
      content: textContent("userId is required for remove_participant."),
      isError: true,
    };
  }

  // Load conversation to check owner
  const conversation = await ctx.conversationStore.load(conversationId);
  if (!conversation) {
    return {
      content: textContent(`Conversation not found: ${conversationId}`),
      isError: true,
    };
  }

  // Cannot remove the owner
  if (conversation.ownerId === userId) {
    return {
      content: textContent("Cannot remove the conversation owner."),
      isError: false,
    };
  }

  const result = await ctx.conversationStore.removeParticipant(conversationId, userId);
  if (!result) {
    return {
      content: textContent(`Failed to remove participant from conversation ${conversationId}.`),
      isError: true,
    };
  }
  // Evict the removed user's conversation subscribers
  ctx.conversationEventManager?.removeUserFromConversation(conversationId, userId);
  const data = {
    conversationId: result.id,
    participants: result.participants,
  };
  return {
    content: textContent(`Removed participant from conversation ${result.id}.`),
    structuredContent: data,
    isError: false,
  };
}
