import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { CreateUserResult, IdentityProvider, UserIdentity } from "../identity/provider.ts";
import type { UserStore } from "../identity/user.ts";
import type { InProcessTool } from "./in-process-app.ts";

// ── Types ─────────────────────────────────────────────────────────

export interface ManageUsersContext {
  /** Returns the requesting user's identity, or null if unauthenticated. */
  getIdentity: () => UserIdentity | null;
  userStore: UserStore;
  provider: IdentityProvider | null;
}

// ── Permission check ──────────────────────────────────────────────

const ADMIN_ROLES = new Set(["admin", "owner"]);

function isAdmin(identity: UserIdentity | null): boolean {
  return identity !== null && ADMIN_ROLES.has(identity.orgRole);
}

function permissionDenied(): ToolResult {
  return {
    content: textContent("You don't have permission to manage users. Ask an org admin."),
    isError: true,
  };
}

// ── Tool factory ──────────────────────────────────────────────────

export function createManageUsersTool(ctx: ManageUsersContext): InProcessTool {
  return {
    name: "manage_users",
    description:
      "Create, update, delete, or list workspace users. Only org admins and owners can use this tool.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "delete", "list"],
          description: "Action to perform.",
        },
        email: {
          type: "string",
          description: "User email (required for create).",
        },
        displayName: {
          type: "string",
          description: "User display name (required for create, optional for update).",
        },
        orgRole: {
          type: "string",
          enum: ["owner", "admin", "member"],
          description: 'Org role (defaults to "member" on create).',
        },
        userId: {
          type: "string",
          description: "User ID (required for update and delete).",
        },
      },
      required: ["action"],
    },
    handler: async (input): Promise<ToolResult> => {
      const identity = ctx.getIdentity();
      if (!isAdmin(identity)) {
        return permissionDenied();
      }

      const action = String(input.action);

      switch (action) {
        case "create":
          return handleCreate(ctx, input);
        case "update":
          return handleUpdate(ctx, input);
        case "delete":
          return handleDelete(ctx, input);
        case "list":
          return handleList(ctx);
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

async function handleCreate(
  ctx: ManageUsersContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const email = input.email ? String(input.email) : undefined;
  const displayName = input.displayName ? String(input.displayName) : undefined;

  if (!email || !displayName) {
    return {
      content: textContent("Both email and displayName are required to create a user."),
      isError: true,
    };
  }

  const orgRole = input.orgRole ? String(input.orgRole) : "member";
  if (!["owner", "admin", "member"].includes(orgRole)) {
    return {
      content: textContent(`Invalid orgRole: ${orgRole}. Must be owner, admin, or member.`),
      isError: true,
    };
  }

  try {
    if (ctx.provider) {
      const result: CreateUserResult = await ctx.provider.createUser({
        email,
        displayName,
        orgRole: orgRole as "owner" | "admin" | "member",
      });
      return {
        content: textContent(`Created user ${result.user.email}.`),
        structuredContent: {
          user: {
            id: result.user.id,
            email: result.user.email,
            displayName: result.user.displayName,
            orgRole: result.user.orgRole,
            createdAt: result.user.createdAt,
          },
        },
        isError: false,
      };
    }

    // Fallback: use UserStore directly (no API key returned)
    const user = await ctx.userStore.create({
      email,
      displayName,
      orgRole: orgRole as "owner" | "admin" | "member",
    });
    const userData = {
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        orgRole: user.orgRole,
        createdAt: user.createdAt,
      },
    };
    return {
      content: textContent(`Created user ${user.email}.`),
      structuredContent: userData,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to create user: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleUpdate(
  ctx: ManageUsersContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return {
      content: textContent("userId is required for update."),
      isError: true,
    };
  }

  const patch: Record<string, unknown> = {};
  if (input.email !== undefined) patch.email = String(input.email);
  if (input.displayName !== undefined) patch.displayName = String(input.displayName);
  if (input.orgRole !== undefined) {
    const orgRole = String(input.orgRole);
    if (!["owner", "admin", "member"].includes(orgRole)) {
      return {
        content: textContent(`Invalid orgRole: ${orgRole}. Must be owner, admin, or member.`),
        isError: true,
      };
    }
    patch.orgRole = orgRole;
  }

  if (Object.keys(patch).length === 0) {
    return {
      content: textContent("No fields to update. Provide email, displayName, or orgRole."),
      isError: true,
    };
  }

  try {
    // Safety check: cannot downgrade the last owner
    if (patch.orgRole && patch.orgRole !== "owner") {
      const currentUser = await ctx.userStore.get(userId);
      if (currentUser?.orgRole === "owner") {
        const allUsers = await ctx.userStore.list();
        const ownerCount = allUsers.filter((u) => u.orgRole === "owner").length;
        if (ownerCount <= 1) {
          return {
            content: textContent(
              "Cannot change the role of the last owner. Promote another user to owner first.",
            ),
            isError: false,
          };
        }
      }
    }

    const updated = await ctx.userStore.update(userId, patch);
    if (!updated) {
      return {
        content: textContent(`User not found: ${userId}`),
        isError: true,
      };
    }

    const userData = {
      user: {
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        orgRole: updated.orgRole,
        updatedAt: updated.updatedAt,
      },
    };
    return {
      content: textContent(`Updated user ${updated.email}.`),
      structuredContent: userData,
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to update user: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleDelete(
  ctx: ManageUsersContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return {
      content: textContent("userId is required for delete."),
      isError: true,
    };
  }

  try {
    // Safety check: cannot delete the last owner
    const user = await ctx.userStore.get(userId);
    if (!user) {
      return {
        content: textContent(`User not found: ${userId}`),
        isError: true,
      };
    }

    if (user.orgRole === "owner") {
      const allUsers = await ctx.userStore.list();
      const ownerCount = allUsers.filter((u) => u.orgRole === "owner").length;
      if (ownerCount <= 1) {
        return {
          content: textContent(
            "Cannot delete the last owner. Promote another user to owner first.",
          ),
          isError: false,
        };
      }
    }

    const deleted = await ctx.provider!.deleteUser(userId);
    if (!deleted) {
      return {
        content: textContent(`User not found: ${userId}`),
        isError: true,
      };
    }

    return {
      content: textContent(`Deleted user ${userId}.`),
      structuredContent: { deleted: true, userId },
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to delete user: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

async function handleList(ctx: ManageUsersContext): Promise<ToolResult> {
  try {
    const users = await ctx.userStore.list();
    const result = users.map((u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      orgRole: u.orgRole,
    }));
    return {
      content: textContent(`${result.length} user(s).`),
      structuredContent: { users: result },
      isError: false,
    };
  } catch (err) {
    return {
      content: textContent(
        `Failed to list users: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}
