import { textContent } from "../engine/content-helpers.ts";
import { INTERNAL_TOOL_ANNOTATION, type ToolResult } from "../engine/types.ts";
import type { CreateUserResult, IdentityProvider, UserIdentity } from "../identity/provider.ts";
import { ORG_ADMIN_ROLES } from "../identity/types.ts";
import type { User, UserStore } from "../identity/user.ts";
import type { InProcessTool } from "./in-process-app.ts";

// ── Types ─────────────────────────────────────────────────────────

export interface ManageUsersContext {
  /** Returns the requesting user's identity, or null if unauthenticated. */
  getIdentity: () => UserIdentity | null;
  userStore: UserStore;
  provider: IdentityProvider | null;
}

// ── Permission check ──────────────────────────────────────────────

function isAdmin(identity: UserIdentity | null): boolean {
  return identity !== null && ORG_ADMIN_ROLES.has(identity.orgRole);
}

function permissionDenied(): ToolResult {
  return {
    content: textContent("You don't have permission to manage users. Ask an org admin."),
    isError: true,
  };
}

/**
 * Count org owners that are still active (not soft-deleted). The last-owner
 * guards on both the update (demote) and delete (deactivate) paths use this so
 * a deactivated owner can never be mistaken for a live one — otherwise you
 * could demote/deactivate the last *active* owner and lock the org out.
 */
function activeOwnerCount(users: User[]): number {
  return users.filter((u) => u.orgRole === "owner" && !u.deletedAt).length;
}

// ── Shared helpers ────────────────────────────────────────────────

const ORG_ROLES = ["owner", "admin", "member"];

/** True when the value is one of the accepted org roles. */
function isValidOrgRole(role: string): boolean {
  return ORG_ROLES.includes(role);
}

/** Error result for an org role outside the accepted set. */
function invalidOrgRoleResult(role: string): ToolResult {
  return {
    content: textContent(`Invalid orgRole: ${role}. Must be owner, admin, or member.`),
    isError: true,
  };
}

/** Error result when no user matches the given id. */
function userNotFoundResult(userId: string): ToolResult {
  return {
    content: textContent(`User not found: ${userId}`),
    isError: true,
  };
}

/** Error result wrapping a thrown error behind an action phrase. */
function failureResult(action: string, err: unknown): ToolResult {
  return {
    content: textContent(
      `Failed to ${action}: ${err instanceof Error ? err.message : String(err)}`,
    ),
    isError: true,
  };
}

/** True when this live owner is the only active owner left in the org. */
async function isLastActiveOwner(ctx: ManageUsersContext, user: User): Promise<boolean> {
  if (user.orgRole !== "owner" || user.deletedAt) {
    return false;
  }
  const allUsers = await ctx.userStore.list();
  return activeOwnerCount(allUsers) <= 1;
}

// ── Tool factory ──────────────────────────────────────────────────

export function createManageUsersTool(ctx: ManageUsersContext): InProcessTool {
  return {
    name: "manage_users",
    description:
      "Create, update, delete, or list workspace users. Only org admins and owners can use this tool.",
    annotations: { [INTERNAL_TOOL_ANNOTATION]: true },
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "update", "delete", "restore", "list"],
          description:
            'Action to perform. "delete" deactivates the user (soft delete) and revokes access; "restore" re-enables a deactivated user.',
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
        case "restore":
          return handleRestore(ctx, input);
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
  if (!isValidOrgRole(orgRole)) {
    return invalidOrgRoleResult(orgRole);
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
    return failureResult("create user", err);
  }
}

type PatchResult = { patch: Record<string, unknown> } | { error: ToolResult };

/** Build the update patch from input, or an error result for an invalid orgRole. */
function buildUserPatch(input: Record<string, unknown>): PatchResult {
  const patch: Record<string, unknown> = {};
  if (input.email !== undefined) patch.email = String(input.email);
  if (input.displayName !== undefined) patch.displayName = String(input.displayName);
  if (input.orgRole !== undefined) {
    const orgRole = String(input.orgRole);
    if (!isValidOrgRole(orgRole)) {
      return { error: invalidOrgRoleResult(orgRole) };
    }
    patch.orgRole = orgRole;
  }
  return { patch };
}

/** True when applying this patch would demote the org's last active owner. */
async function wouldOrphanLastOwner(
  ctx: ManageUsersContext,
  userId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  if (!patch.orgRole || patch.orgRole === "owner") {
    return false;
  }
  const currentUser = await ctx.userStore.get(userId);
  if (!currentUser) {
    return false;
  }
  return isLastActiveOwner(ctx, currentUser);
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

  const built = buildUserPatch(input);
  if ("error" in built) {
    return built.error;
  }
  const { patch } = built;

  if (Object.keys(patch).length === 0) {
    return {
      content: textContent("No fields to update. Provide email, displayName, or orgRole."),
      isError: true,
    };
  }

  try {
    // Safety check: cannot downgrade the last active owner
    if (await wouldOrphanLastOwner(ctx, userId, patch)) {
      return {
        content: textContent(
          "Cannot change the role of the last owner. Promote another user to owner first.",
        ),
        isError: false,
      };
    }

    const updated = await ctx.userStore.update(userId, patch);
    if (!updated) {
      return userNotFoundResult(userId);
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
    return failureResult("update user", err);
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
      return userNotFoundResult(userId);
    }

    if (await isLastActiveOwner(ctx, user)) {
      return {
        content: textContent("Cannot delete the last owner. Promote another user to owner first."),
        isError: false,
      };
    }

    // Soft delete: stamp a tombstone and revoke access, but keep the record so
    // the user still appears (as deactivated) and can be restored. We do NOT
    // hard-delete the provider identity — that's irreversible and re-creating
    // the user later mints a new ID, orphaning all prior workspace memberships.
    const deactivated = await ctx.userStore.softDelete(userId);
    if (!deactivated) {
      return userNotFoundResult(userId);
    }

    // Drop any cached identity so the access revocation takes effect immediately.
    ctx.provider?.invalidateUser?.(userId);

    return {
      content: textContent(
        `Deactivated user ${userId}. They can no longer sign in. Use action "restore" to re-enable.`,
      ),
      structuredContent: { deactivated: true, userId, deletedAt: deactivated.deletedAt },
      isError: false,
    };
  } catch (err) {
    return failureResult("deactivate user", err);
  }
}

async function handleRestore(
  ctx: ManageUsersContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return {
      content: textContent("userId is required for restore."),
      isError: true,
    };
  }

  try {
    const restored = await ctx.userStore.restore(userId);
    if (!restored) {
      return userNotFoundResult(userId);
    }

    ctx.provider?.invalidateUser?.(userId);

    return {
      content: textContent(`Restored user ${userId}. They can sign in again.`),
      structuredContent: { restored: true, userId },
      isError: false,
    };
  } catch (err) {
    return failureResult("restore user", err);
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
      // Present only for deactivated users so the UI can render a "deleted" state.
      ...(u.deletedAt ? { deletedAt: u.deletedAt } : {}),
    }));
    return {
      content: textContent(`${result.length} user(s).`),
      structuredContent: { users: result },
      isError: false,
    };
  } catch (err) {
    return failureResult("list users", err);
  }
}
