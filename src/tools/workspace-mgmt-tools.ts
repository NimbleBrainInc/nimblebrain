import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { ORG_ADMIN_ROLES } from "../identity/types.ts";
import type { UserStore } from "../identity/user.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import {
  canManageConversation,
  handleAddParticipant,
  handleRemoveParticipant,
  handleShareConversation,
  handleUnshareConversation,
} from "./conversation-tools.ts";
import type { InProcessTool } from "./in-process-app.ts";

// ── Types ─────────────────────────────────────────────────────────

export interface ManageWorkspacesContext {
  /** Returns the requesting user's identity, or null if unauthenticated. */
  getIdentity: () => UserIdentity | null;
  workspaceStore: WorkspaceStore;
  /** Required for member management (user validation, display name enrichment). */
  userStore?: UserStore;
  /** Required for conversation management (load, share, participant ops). */
  conversationStore?: import("../conversation/types.ts").ConversationStore;
  /** Per-conversation event manager — evict subscribers on participant removal. */
  conversationEventManager?: import("../api/conversation-events.ts").ConversationEventManager;
}

/** @deprecated Use ManageWorkspacesContext instead — members are now managed via manage_workspaces. */
export type ManageMembersContext = ManageWorkspacesContext & { userStore: UserStore };

// ── Permission check ──────────────────────────────────────────────

const ADMIN_ROLES = new Set(["admin", "owner"]);

function isAdmin(identity: UserIdentity | null): boolean {
  return identity !== null && ADMIN_ROLES.has(identity.orgRole);
}

function permissionDenied(): ToolResult {
  return {
    content: textContent("You don't have permission to manage workspaces. Ask an org admin."),
    isError: false,
  };
}

// ── Tool factory ──────────────────────────────────────────────────

export function createManageWorkspacesTool(ctx: ManageWorkspacesContext): InProcessTool {
  return {
    name: "manage_workspaces",
    description:
      "Manage workspaces, their members, and conversation sharing. Workspace CRUD requires org admin. Member management requires workspace or org admin. Conversation sharing requires conversation owner or workspace admin.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "update",
            "delete",
            "list",
            "add_member",
            "remove_member",
            "update_member",
            "list_members",
            "share_conversation",
            "unshare_conversation",
            "add_participant",
            "remove_participant",
          ],
          description: "Action to perform.",
        },
        name: {
          type: "string",
          description: "Workspace name (required for create, optional for update).",
        },
        slug: {
          type: "string",
          description: "Optional slug override (for create). Derived from name if omitted.",
        },
        workspaceId: {
          type: "string",
          description: "Workspace ID (required for most actions except create/list).",
        },
        bundles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              path: { type: "string" },
            },
          },
          description: "Bundle references (optional for create and update).",
        },
        userId: {
          type: "string",
          description: "User ID (for member and participant actions).",
        },
        role: {
          type: "string",
          enum: ["admin", "member"],
          description: "Workspace role (for add_member, update_member).",
        },
        conversationId: {
          type: "string",
          description: "Conversation ID (for conversation sharing actions).",
        },
      },
      required: ["action"],
    },
    handler: async (input): Promise<ToolResult> => {
      const action = String(input.action);

      // Workspace CRUD — requires org admin
      if (["create", "update", "delete", "list"].includes(action)) {
        const identity = ctx.getIdentity();
        if (!isAdmin(identity)) return permissionDenied();

        switch (action) {
          case "create":
            return handleCreate(ctx, input);
          case "update":
            return handleUpdate(ctx, input);
          case "delete":
            return handleDelete(ctx, input);
          case "list":
            return handleList(ctx);
        }
      }

      // Member management — requires workspace admin or org admin
      if (["add_member", "remove_member", "update_member", "list_members"].includes(action)) {
        if (!ctx.userStore) {
          return { content: textContent("Member management not available."), isError: true };
        }
        const workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;
        if (!workspaceId) {
          return { content: textContent("workspaceId is required."), isError: true };
        }
        if (!(await canManageMembers(ctx as ManageMembersContext, workspaceId))) {
          return memberPermissionDenied();
        }
        switch (action) {
          case "add_member":
            return handleAddMember(ctx as ManageMembersContext, workspaceId, input);
          case "remove_member":
            return handleRemoveMember(ctx as ManageMembersContext, workspaceId, input);
          case "update_member":
            return handleUpdateMember(ctx as ManageMembersContext, workspaceId, input);
          case "list_members":
            return handleListMembers(ctx as ManageMembersContext, workspaceId);
        }
      }

      // Conversation sharing — requires conversation owner or workspace admin
      if (
        [
          "share_conversation",
          "unshare_conversation",
          "add_participant",
          "remove_participant",
        ].includes(action)
      ) {
        if (!ctx.conversationStore) {
          return { content: textContent("Conversation management not available."), isError: true };
        }
        const identity = ctx.getIdentity();
        if (!identity) {
          return { content: textContent("Authentication required."), isError: true };
        }
        const conversationId = input.conversationId ? String(input.conversationId) : undefined;
        if (!conversationId) {
          return { content: textContent("conversationId is required."), isError: true };
        }
        const convCtx = {
          getIdentity: ctx.getIdentity,
          conversationStore: ctx.conversationStore,
          workspaceStore: ctx.workspaceStore,
          conversationEventManager: ctx.conversationEventManager,
        };
        const check = await canManageConversation(convCtx, conversationId, identity);
        if (!check.allowed) {
          return { content: textContent(check.reason!), isError: false };
        }
        switch (action) {
          case "share_conversation":
            return handleShareConversation(convCtx, conversationId, identity);
          case "unshare_conversation":
            return handleUnshareConversation(convCtx, conversationId, identity);
          case "add_participant":
            return handleAddParticipant(convCtx, conversationId, input);
          case "remove_participant":
            return handleRemoveParticipant(convCtx, conversationId, input);
        }
      }

      return { content: textContent(`Unknown action: ${action}`), isError: true };
    },
  };
}

// ── Action handlers ───────────────────────────────────────────────

async function handleCreate(
  ctx: ManageWorkspacesContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const name = input.name ? String(input.name) : undefined;
  if (!name) {
    return {
      content: textContent("name is required to create a workspace."),
      isError: true,
    };
  }

  const slug = input.slug ? String(input.slug) : undefined;
  const bundles = input.bundles as Array<Record<string, unknown>> | undefined;

  try {
    const workspace = await ctx.workspaceStore.create(name, slug);

    // If bundles were provided, update the workspace with them
    if (bundles && bundles.length > 0) {
      const bundleRefs = bundles.map((b) => {
        if (b.name) return { name: String(b.name) };
        if (b.path) return { path: String(b.path) };
        return { name: String(b.name ?? "") };
      });
      await ctx.workspaceStore.update(workspace.id, { bundles: bundleRefs });
      workspace.bundles = bundleRefs;
    }

    const data = {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        bundles: workspace.bundles,
        createdAt: workspace.createdAt,
      },
    };
    return {
      content: textContent(`Created workspace '${workspace.name}'.`),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to create workspace: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleUpdate(
  ctx: ManageWorkspacesContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;
  if (!workspaceId) {
    return {
      content: textContent("workspaceId is required for update."),
      isError: true,
    };
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = String(input.name);
  if (input.bundles !== undefined) {
    const bundles = input.bundles as Array<Record<string, unknown>>;
    patch.bundles = bundles.map((b) => {
      if (b.name) return { name: String(b.name) };
      if (b.path) return { path: String(b.path) };
      return { name: String(b.name ?? "") };
    });
  }

  if (Object.keys(patch).length === 0) {
    return {
      content: textContent("No fields to update. Provide name or bundles."),
      isError: true,
    };
  }

  try {
    const updated = await ctx.workspaceStore.update(workspaceId, patch);
    if (!updated) {
      return {
        content: textContent(`Workspace not found: ${workspaceId}`),
        isError: true,
      };
    }

    const data = {
      workspace: {
        id: updated.id,
        name: updated.name,
        bundles: updated.bundles,
        memberCount: updated.members.length,
        updatedAt: updated.updatedAt,
      },
    };
    return {
      content: textContent(`Updated workspace '${updated.name}'.`),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to update workspace: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleDelete(
  ctx: ManageWorkspacesContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;
  if (!workspaceId) {
    return {
      content: textContent("workspaceId is required for delete."),
      isError: true,
    };
  }

  try {
    const deleted = await ctx.workspaceStore.delete(workspaceId);
    if (!deleted) {
      return {
        content: textContent(`Workspace not found: ${workspaceId}`),
        isError: true,
      };
    }

    const data = { deleted: true, workspaceId };
    return {
      content: textContent(`Deleted workspace ${workspaceId}.`),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to delete workspace: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleList(ctx: ManageWorkspacesContext): Promise<ToolResult> {
  try {
    const workspaces = await ctx.workspaceStore.list();
    const identity = ctx.getIdentity();
    const result = workspaces.map((ws) => {
      const userRole = identity
        ? ws.members.find((m) => m.userId === identity.id)?.role
        : undefined;
      return {
        id: ws.id,
        name: ws.name,
        memberCount: ws.members.length,
        bundles: ws.bundles,
        createdAt: ws.createdAt,
        // The requester's role within this workspace, when applicable. Lets the
        // web client gate workspace-admin UI without an extra `list_members`
        // round-trip per workspace.
        ...(userRole ? { userRole } : {}),
      };
    });
    const data = { workspaces: result };
    return {
      content: textContent(`${result.length} workspace(s).`),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to list workspaces: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

// ══════════════════════════════════════════════════════════════════
// nb__manage_members tool
// ══════════════════════════════════════════════════════════════════

/**
 * Check whether the requesting user can manage members in the given workspace.
 * Allowed when:
 *  1. The user is an org-level admin or owner, OR
 *  2. The user is a workspace-level admin for this specific workspace.
 */
async function canManageMembers(ctx: ManageMembersContext, workspaceId: string): Promise<boolean> {
  const identity = ctx.getIdentity();
  if (!identity) return false;

  // Org admin/owner can manage any workspace
  if (ORG_ADMIN_ROLES.has(identity.orgRole)) return true;

  // Check workspace-level admin
  const ws = await ctx.workspaceStore.get(workspaceId);
  if (!ws) return false;

  const member = ws.members.find((m) => m.userId === identity.id);
  return member?.role === "admin";
}

function memberPermissionDenied(): ToolResult {
  return {
    content: textContent(
      "You don't have permission to manage members. Requires workspace admin or org admin/owner.",
    ),
    isError: false,
  };
}

/** @deprecated Member management is now handled by manage_workspaces. Kept for test coverage of handler logic. */
export function createManageMembersTool(ctx: ManageMembersContext): InProcessTool {
  return {
    name: "manage_members",
    description:
      "Add, remove, update, or list members in a workspace. Requires workspace admin or org admin/owner.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "remove", "update", "list"],
          description: "Action to perform.",
        },
        workspaceId: {
          type: "string",
          description: "Workspace ID (required for all actions).",
        },
        userId: {
          type: "string",
          description: "User ID (required for add, remove, update).",
        },
        role: {
          type: "string",
          enum: ["admin", "member"],
          description:
            "Workspace role (optional for add — defaults to member; required for update).",
        },
      },
      required: ["action", "workspaceId"],
    },
    handler: async (input): Promise<ToolResult> => {
      const action = String(input.action);
      const workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;

      if (!workspaceId) {
        return {
          content: textContent("workspaceId is required."),
          isError: true,
        };
      }

      if (!(await canManageMembers(ctx, workspaceId))) {
        return memberPermissionDenied();
      }

      switch (action) {
        case "add":
          return handleAddMember(ctx, workspaceId, input);
        case "remove":
          return handleRemoveMember(ctx, workspaceId, input);
        case "update":
          return handleUpdateMember(ctx, workspaceId, input);
        case "list":
          return handleListMembers(ctx, workspaceId);
        default:
          return {
            content: textContent(`Unknown action: ${action}`),
            isError: true,
          };
      }
    },
  };
}

// ── Member action handlers ────────────────────────────────────────

async function handleAddMember(
  ctx: ManageMembersContext,
  workspaceId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return {
      content: textContent("userId is required to add a member."),
      isError: true,
    };
  }

  // Validate user exists
  const user = await ctx.userStore.get(userId);
  if (!user) {
    return {
      content: textContent("User not found"),
      isError: true,
    };
  }

  const role = input.role ? String(input.role) : "member";
  if (role !== "admin" && role !== "member") {
    return {
      content: textContent(`Invalid role: ${role}. Must be "admin" or "member".`),
      isError: true,
    };
  }

  try {
    const ws = await ctx.workspaceStore.addMember(workspaceId, userId, role);
    const data = {
      added: { userId, role },
      workspace: { id: ws.id, memberCount: ws.members.length },
    };
    return {
      content: textContent(`Added member ${userId} to workspace.`),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to add member: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleRemoveMember(
  ctx: ManageMembersContext,
  workspaceId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return {
      content: textContent("userId is required to remove a member."),
      isError: true,
    };
  }

  // Safety: cannot remove last workspace admin
  const ws = await ctx.workspaceStore.get(workspaceId);
  if (!ws) {
    return {
      content: textContent(`Workspace not found: ${workspaceId}`),
      isError: true,
    };
  }

  const target = ws.members.find((m) => m.userId === userId);
  if (!target) {
    return {
      content: textContent(`User "${userId}" is not a member of this workspace.`),
      isError: true,
    };
  }

  if (target.role === "admin") {
    const adminCount = ws.members.filter((m) => m.role === "admin").length;
    if (adminCount <= 1) {
      return {
        content: textContent("Cannot remove the last workspace admin."),
        isError: true,
      };
    }
  }

  try {
    const updated = await ctx.workspaceStore.removeMember(workspaceId, userId);
    const data = {
      removed: { userId },
      workspace: { id: updated.id, memberCount: updated.members.length },
    };
    return {
      content: textContent("Removed member from workspace."),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to remove member: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleUpdateMember(
  ctx: ManageMembersContext,
  workspaceId: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return {
      content: textContent("userId is required to update a member."),
      isError: true,
    };
  }

  const role = input.role ? String(input.role) : undefined;
  if (!role) {
    return {
      content: textContent("role is required to update a member."),
      isError: true,
    };
  }

  if (role !== "admin" && role !== "member") {
    return {
      content: textContent(`Invalid role: ${role}. Must be "admin" or "member".`),
      isError: true,
    };
  }

  // Safety: if demoting an admin, ensure they're not the last one
  const ws = await ctx.workspaceStore.get(workspaceId);
  if (!ws) {
    return {
      content: textContent(`Workspace not found: ${workspaceId}`),
      isError: true,
    };
  }

  const target = ws.members.find((m) => m.userId === userId);
  if (!target) {
    return {
      content: textContent(`User "${userId}" is not a member of this workspace.`),
      isError: true,
    };
  }

  if (target.role === "admin" && role === "member") {
    const adminCount = ws.members.filter((m) => m.role === "admin").length;
    if (adminCount <= 1) {
      return {
        content: textContent("Cannot demote the last workspace admin."),
        isError: true,
      };
    }
  }

  try {
    const updated = await ctx.workspaceStore.updateMemberRole(workspaceId, userId, role);
    const member = updated.members.find((m) => m.userId === userId);
    const data = {
      updated: { userId, role: member?.role },
      workspace: { id: updated.id, memberCount: updated.members.length },
    };
    return {
      content: textContent("Updated role for member."),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to update member: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleListMembers(
  ctx: ManageMembersContext,
  workspaceId: string,
): Promise<ToolResult> {
  const ws = await ctx.workspaceStore.get(workspaceId);
  if (!ws) {
    return {
      content: textContent(`Workspace not found: ${workspaceId}`),
      isError: true,
    };
  }

  // Enrich members with display names and emails from user profiles
  const enrichedMembers = await Promise.all(
    ws.members.map(async (m) => {
      const user = await ctx.userStore.get(m.userId);
      return {
        userId: m.userId,
        role: m.role,
        displayName: user?.displayName ?? m.userId,
        email: user?.email ?? "",
      };
    }),
  );

  const data = {
    workspaceId: ws.id,
    members: enrichedMembers,
  };
  return {
    content: textContent(`${enrichedMembers.length} member(s) in workspace.`),
    structuredContent: data,
    isError: false,
  };
}
