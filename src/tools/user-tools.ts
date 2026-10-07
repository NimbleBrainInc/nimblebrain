import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type {
  CreateUserResult,
  IdentityProvider,
  UpdateUserInput,
  UserEditField,
  UserIdentity,
} from "../identity/provider.ts";
import { ORG_ADMIN_ROLES, type OrgRole } from "../identity/types.ts";
import { type User, UserConflictError, type UserStore } from "../identity/user.ts";
import type { InProcessTool } from "./in-process-app.ts";
import { WORKSPACE_OPTIONAL_META } from "./workspace-optional.ts";

// ── Types ─────────────────────────────────────────────────────────

export interface ManageUsersContext {
  /** Returns the requesting user's identity, or null if unauthenticated. */
  getIdentity: () => UserIdentity | null;
  userStore: UserStore;
  provider: IdentityProvider;
}

// ── Permission check ──────────────────────────────────────────────

function isAdmin(identity: UserIdentity): boolean {
  return ORG_ADMIN_ROLES.has(identity.orgRole);
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
    meta: { ui: { visibility: ["app"] }, ...WORKSPACE_OPTIONAL_META },
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
          description:
            "User email (required for create, optional for update). Refused on update when the identity provider owns it.",
        },
        displayName: {
          type: "string",
          description: "User display name (required for create, optional for update).",
        },
        orgRole: {
          type: "string",
          enum: ["owner", "admin", "member"],
          description:
            'Org role (defaults to "member" on create). On update, refused for your own role and for the last active owner.',
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
      if (!identity || !isAdmin(identity)) {
        return permissionDenied();
      }

      const action = String(input.action);

      switch (action) {
        case "create":
          return handleCreate(ctx, input);
        case "update":
          return handleUpdate(ctx, identity, input);
        case "delete":
          return handleDelete(ctx, identity, input);
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
  } catch (err) {
    return failureResult("create user", err);
  }
}

type PatchResult = { patch: UpdateUserInput } | { error: ToolResult };

const FIELD_LABELS: Record<UserEditField, string> = {
  email: "Email",
  displayName: "Display name",
  orgRole: "Role",
};

function refusal(message: string): ToolResult {
  return { content: textContent(message), isError: true };
}

/**
 * Build the update patch from input, or an error result for a value the user
 * record cannot hold. A field omitted is left alone; none of these fields can
 * be cleared, so `null` is refused rather than stored.
 */
function buildUserPatch(input: Record<string, unknown>): PatchResult {
  const patch: UpdateUserInput = {};
  for (const field of ["email", "displayName", "orgRole"] as const) {
    if (input[field] === null) {
      return { error: refusal(`${FIELD_LABELS[field]} can't be cleared.`) };
    }
  }
  if (input.email !== undefined) {
    const email = String(input.email).trim();
    if (!email.includes("@")) {
      return { error: refusal("Enter an email address, such as name@example.com.") };
    }
    patch.email = email;
  }
  if (input.displayName !== undefined) {
    const displayName = String(input.displayName).trim();
    if (!displayName) {
      return { error: refusal("A user needs a display name.") };
    }
    patch.displayName = displayName;
  }
  if (input.orgRole !== undefined) {
    const orgRole = String(input.orgRole);
    if (!isValidOrgRole(orgRole)) {
      return { error: invalidOrgRoleResult(orgRole) };
    }
    patch.orgRole = orgRole as OrgRole;
  }
  return { patch };
}

/**
 * Why this edit of this user is refused, or null when it may go ahead. Mirrored
 * by the Users page, which disables what these refuse; the server's answer is
 * the one that counts.
 */
async function updateRefusal(
  ctx: ManageUsersContext,
  identity: UserIdentity,
  user: User,
  patch: UpdateUserInput,
): Promise<string | null> {
  const owned = ctx.provider.capabilities.providerOwnedUserFields ?? [];
  for (const field of owned) {
    if (patch[field] !== undefined && patch[field] !== user[field]) {
      return `${FIELD_LABELS[field]} is managed by this organization's identity provider. Change it there.`;
    }
  }
  if (user.deletedAt) {
    return `${user.email} is deactivated. Restore them before editing.`;
  }
  if (patch.orgRole === undefined || patch.orgRole === user.orgRole) {
    return null;
  }
  // Your own role is changed by someone else, so a manager can never demote
  // themselves out of managing, and the org always keeps one who can.
  if (user.id === identity.id) {
    return "You can't change your own role. Ask another admin or owner.";
  }
  if (patch.orgRole !== "owner" && (await isLastActiveOwner(ctx, user))) {
    return "Cannot change the role of the last owner. Promote another user to owner first.";
  }
  return null;
}

async function handleUpdate(
  ctx: ManageUsersContext,
  identity: UserIdentity,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return refusal("userId is required for update.");
  }

  const built = buildUserPatch(input);
  if ("error" in built) {
    return built.error;
  }
  const { patch } = built;

  if (Object.keys(patch).length === 0) {
    return refusal("No fields to update. Provide email, displayName, or orgRole.");
  }

  try {
    const user = await ctx.userStore.get(userId);
    if (!user) {
      return userNotFoundResult(userId);
    }
    const refused = await updateRefusal(ctx, identity, user, patch);
    if (refused) {
      return refusal(refused);
    }

    // A provider with its own directory writes it as well as the local
    // profile, or its next sync would put the old value back.
    const updated = ctx.provider.updateUser
      ? await ctx.provider.updateUser(userId, patch)
      : await ctx.userStore.update(userId, patch);
    if (!updated) {
      return userNotFoundResult(userId);
    }
    // A cached identity carries the old role; drop it so the change applies now.
    ctx.provider.invalidateUser?.(userId);

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
    if (err instanceof UserConflictError) {
      return refusal(err.message);
    }
    return failureResult("update user", err);
  }
}

async function handleDelete(
  ctx: ManageUsersContext,
  identity: UserIdentity,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const userId = input.userId ? String(input.userId) : undefined;
  if (!userId) {
    return {
      content: textContent("userId is required for delete."),
      isError: true,
    };
  }
  if (userId === identity.id) {
    return refusal("You can't deactivate yourself. Ask another admin or owner.");
  }

  try {
    // Safety check: cannot delete the last owner
    const user = await ctx.userStore.get(userId);
    if (!user) {
      return userNotFoundResult(userId);
    }

    if (await isLastActiveOwner(ctx, user)) {
      return refusal("Cannot delete the last owner. Promote another user to owner first.");
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
    ctx.provider.invalidateUser?.(userId);

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

    ctx.provider.invalidateUser?.(userId);

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
      // The fields `update` refuses under this identity provider, so the Users
      // page can say so before an edit rather than after.
      structuredContent: {
        users: result,
        providerOwnedFields: [...(ctx.provider.capabilities.providerOwnedUserFields ?? [])],
      },
      isError: false,
    };
  } catch (err) {
    return failureResult("list users", err);
  }
}
