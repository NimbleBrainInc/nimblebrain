import { textContent } from "../engine/content-helpers.ts";
import type { ToolResult } from "../engine/types.ts";
import type { UserIdentity } from "../identity/provider.ts";
import { ORG_ADMIN_ROLES } from "../identity/types.ts";
import type { UserStore } from "../identity/user.ts";
import { canWriteWorkspaceScoped } from "../workspace/authz.ts";
import { PersonalWorkspaceInvariantError } from "../workspace/errors.ts";
import type { WorkspaceMember } from "../workspace/types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { InProcessTool } from "./in-process-app.ts";

// ── Types ─────────────────────────────────────────────────────────

export interface ManageWorkspacesContext {
  /** Returns the requesting user's identity, or null if unauthenticated. */
  getIdentity: () => UserIdentity | null;
  workspaceStore: WorkspaceStore;
  /** Required for member management (user validation, display name enrichment). */
  userStore?: UserStore;
}

/** @deprecated Use ManageWorkspacesContext instead — members are now managed via manage_workspaces. */
export type ManageMembersContext = ManageWorkspacesContext & { userStore: UserStore };

// ── Permission check ──────────────────────────────────────────────

function isAdmin(identity: UserIdentity | null): identity is UserIdentity {
  return identity !== null && ORG_ADMIN_ROLES.has(identity.orgRole);
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
      "Manage workspaces and their members. Workspace CRUD and claim_admin require org admin. Member management requires workspace admin membership. claim_admin lets an org admin seat themselves as admin of a shared workspace that has no admin member, to recover one that would otherwise be unmanageable. Conversation sharing was removed in Stage 1 of the cross-workspace refactor and returns in Stage 4 with policy-gated primitives.",
    annotations: { "ai.nimblebrain/internal": true },
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
            "claim_admin",
            "add_member",
            "remove_member",
            "update_member",
            "list_members",
          ],
          description: "Action to perform.",
        },
        name: {
          type: "string",
          description: "Workspace name (required for create, optional for update).",
        },
        slug: {
          type: "string",
          description:
            "Optional explicit id slug (for create), producing id 'ws_<slug>'. Omit to get an opaque, name-independent id (the default and recommended path — the workspace name stays freely editable without changing the id or URL).",
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
          description: "User ID (for member actions).",
        },
        role: {
          type: "string",
          enum: ["admin", "member"],
          description: "Workspace role (for add_member, update_member).",
        },
      },
      required: ["action"],
    },
    handler: async (input): Promise<ToolResult> => {
      const action = String(input.action);

      // Workspace CRUD + admin recovery — requires org admin
      if (["create", "update", "delete", "list", "claim_admin"].includes(action)) {
        return dispatchWorkspaceAction(ctx, action, input);
      }

      // Member management — requires workspace admin or org admin
      if (["add_member", "remove_member", "update_member", "list_members"].includes(action)) {
        return dispatchMemberAction(ctx, action, input);
      }

      return { content: textContent(`Unknown action: ${action}`), isError: true };
    },
  };
}

/** Gate workspace CRUD + claim_admin on org admin, then route to its handler. */
async function dispatchWorkspaceAction(
  ctx: ManageWorkspacesContext,
  action: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
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
    case "claim_admin":
      return handleClaimAdmin(ctx, identity, input);
    default:
      return { content: textContent(`Unknown action: ${action}`), isError: true };
  }
}

/** Validate the store + workspaceId, gate on workspace-admin membership, then route to its handler. */
async function dispatchMemberAction(
  ctx: ManageWorkspacesContext,
  action: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
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
    default:
      return { content: textContent(`Unknown action: ${action}`), isError: true };
  }
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
    let workspace = await ctx.workspaceStore.create(name, slug);

    // Seat the creator as an `admin` member. `WorkspaceStore.create`
    // intentionally leaves `members: []`, so a freshly created shared
    // workspace has no one able to manage it. Under the strict
    // workspace-write policy (org-admin override removed), that would
    // strand the workspace permanently — `add_member` is itself gated by
    // `canManageMembers`. Seating the creator here is the bootstrap that
    // keeps the workspace manageable from creation onward.
    //
    // `getIdentity()` is guaranteed non-null by the org-admin gate in the
    // `create` handler above; we still guard defensively rather than
    // assume the invariant holds.
    //
    // Partial-failure window: if `addMember` throws after `create` has
    // persisted, the workspace exists with no admin member. That is the
    // stranded state, and it is recoverable via the `claim_admin` action
    // below — so we don't attempt a compensating delete here.
    const identity = ctx.getIdentity();
    if (identity) {
      workspace = await ctx.workspaceStore.addMember(workspace.id, identity.id, "admin");
    }

    // If bundles were provided, update the workspace with them
    if (bundles && bundles.length > 0) {
      const bundleRefs = bundles.map((b) => {
        if (b.name) return { name: String(b.name) };
        if (b.path) return { path: String(b.path) };
        return { name: String(b.name ?? "") };
      });
      const updated = await ctx.workspaceStore.update(workspace.id, { bundles: bundleRefs });
      if (updated) workspace = updated;
    }

    const data = {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        bundles: workspace.bundles,
        memberCount: workspace.members.length,
        createdAt: workspace.createdAt,
      },
    };
    return {
      content: textContent(`Created workspace '${workspace.name}'.`),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    // PersonalWorkspaceInvariantError propagates to the HTTP layer
    // (mapped to 422). Swallowing it here would degrade a sharp
    // identity-boundary violation into a soft 200 + isError:true.
    if (err instanceof PersonalWorkspaceInvariantError) {
      return personalWorkspaceInvariantToolResult(err);
    }
    return {
      content: textContent(
        `Failed to create workspace: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

/**
 * Org-admin recovery for a shared workspace that has no admin member.
 *
 * Under the strict workspace-write policy, member management requires a
 * workspace admin member and org role grants no bypass. A shared workspace
 * with no admin (e.g. created before the bootstrap fix seated the creator,
 * or one an org admin populated with default-role members under the old
 * org-admin override) would be unmanageable: nobody could add or promote a
 * member, write instructions/identity/skills, or install connectors, and the
 * only blunt recovery — delete + recreate — discards the workspace's content.
 *
 * This action lets an org admin/owner deliberately seat *themselves* as an
 * admin member of such a workspace, restoring a valid actor. It is a narrow,
 * auditable recovery lever, NOT a per-write override: it refuses unless the
 * workspace genuinely has no admin member, so it cannot be used to reach into
 * a healthy workspace the operator simply hasn't joined.
 */
async function handleClaimAdmin(
  ctx: ManageWorkspacesContext,
  identity: UserIdentity,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const workspaceId = input.workspaceId ? String(input.workspaceId) : undefined;
  if (!workspaceId) {
    return { content: textContent("workspaceId is required for claim_admin."), isError: true };
  }

  const ws = await ctx.workspaceStore.get(workspaceId);
  if (!ws) {
    return { content: textContent(`Workspace "${workspaceId}" not found.`), isError: true };
  }

  // Personal workspaces are sole-owner and always have the owner seated as
  // admin at creation, so they can never be stranded — and mutating their
  // membership violates the personal-workspace invariant.
  if (ws.isPersonal === true) {
    return {
      content: textContent(
        "Personal workspaces always have an admin owner; claim_admin does not apply.",
      ),
      isError: true,
    };
  }

  // Narrow the lever: only a workspace with NO admin member is recoverable.
  // Refusing otherwise keeps this from becoming a backdoor org-admin override
  // into a healthy workspace.
  if (ws.members.some((m) => m.role === "admin")) {
    return {
      content: textContent(
        "Workspace already has an admin member. Use add_member / update_member to manage it (requires workspace admin membership).",
      ),
      isError: true,
    };
  }

  try {
    const existing = ws.members.find((m) => m.userId === identity.id);
    const updated = existing
      ? await ctx.workspaceStore.updateMemberRole(workspaceId, identity.id, "admin")
      : await ctx.workspaceStore.addMember(workspaceId, identity.id, "admin");

    const data = {
      workspace: { id: updated.id, name: updated.name, memberCount: updated.members.length },
      claimedAdmin: { userId: identity.id },
    };
    return {
      content: textContent(`Seated ${identity.id} as admin of workspace '${updated.name}'.`),
      structuredContent: data,
      isError: false,
    };
  } catch (err) {
    if (err instanceof PersonalWorkspaceInvariantError) {
      return personalWorkspaceInvariantToolResult(err);
    }
    return {
      content: textContent(
        `Failed to claim admin: ${err instanceof Error ? err.message : String(err)}`,
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
    if (err instanceof PersonalWorkspaceInvariantError) {
      return personalWorkspaceInvariantToolResult(err);
    }
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
        // `isPersonal` lets the web client badge the personal workspace
        // and enforce the personal-workspace invariants in settings.
        // Pre-Stage-1 workspaces return `false`.
        isPersonal: ws.isPersonal === true,
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
 *
 * STRICT policy (see `canWriteWorkspaceScoped`): allowed only when the user is
 * a member of this specific workspace with the `admin` member role. Org role
 * grants no bypass — an org admin/owner who is not a workspace admin member
 * cannot manage members.
 */
async function canManageMembers(ctx: ManageMembersContext, workspaceId: string): Promise<boolean> {
  const identity = ctx.getIdentity();
  const ws = await ctx.workspaceStore.get(workspaceId);
  return canWriteWorkspaceScoped(identity, ws).allowed;
}

function memberPermissionDenied(): ToolResult {
  return {
    content: textContent(
      "You don't have permission to manage members. Requires workspace admin membership.",
    ),
    isError: false,
  };
}

/**
 * Encode `PersonalWorkspaceInvariantError` into the ToolResult so the
 * HTTP layer (`handleToolCall`) can recognize it and map to a 422 with
 * a structured body — the typed error class itself is lost across the
 * in-process MCP serialization boundary. The marker is the `error`
 * field on `structuredContent`; consumers outside the HTTP layer (the
 * agent loop, external MCP clients) see a regular `isError: true`
 * result and can read the same `structuredContent` if they care.
 */
function personalWorkspaceInvariantToolResult(err: PersonalWorkspaceInvariantError): ToolResult {
  return {
    content: textContent(err.message),
    structuredContent: {
      error: "personal_workspace_invariant",
      workspaceId: err.workspaceId,
      reason: err.reason,
      message: err.message,
    },
    isError: true,
  };
}

/** Map a thrown mutation error to a ToolResult, preserving the personal-workspace invariant marker. */
function mutationErrorResult(err: unknown, action: string): ToolResult {
  if (err instanceof PersonalWorkspaceInvariantError) {
    return personalWorkspaceInvariantToolResult(err);
  }
  return {
    content: textContent(
      `Failed to ${action}: ${err instanceof Error ? err.message : String(err)}`,
    ),
    isError: true,
  };
}

/** @deprecated Member management is now handled by manage_workspaces. Kept for test coverage of handler logic. */
export function createManageMembersTool(ctx: ManageMembersContext): InProcessTool {
  return {
    name: "manage_members",
    description:
      "Add, remove, update, or list members in a workspace. Requires workspace admin membership.",
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
    if (err instanceof PersonalWorkspaceInvariantError) {
      return personalWorkspaceInvariantToolResult(err);
    }
    return {
      content: textContent(
        `Failed to add member: ${err instanceof Error ? err.message : String(err)}`,
      ),
      isError: true,
    };
  }
}

/**
 * Count workspace admins whose underlying user is still active (not
 * soft-deleted). The last-admin guards use this so a deactivated admin — who
 * can't actually act, since the auth layer denies them — never counts toward
 * the minimum. Mirrors `activeOwnerCount` in user-tools.ts at the workspace level.
 */
async function activeAdminCount(members: WorkspaceMember[], userStore: UserStore): Promise<number> {
  const admins = members.filter((m) => m.role === "admin");
  const users = await Promise.all(admins.map((m) => userStore.get(m.userId)));
  return users.filter((u) => !u?.deletedAt).length;
}

/** Block acting on the workspace's last active admin; returns the error ToolResult, or null to proceed. */
async function lastActiveAdminGuard(
  ctx: ManageMembersContext,
  members: WorkspaceMember[],
  userId: string,
  message: string,
): Promise<ToolResult | null> {
  // Only guard when the target is an active admin — acting on an already
  // deactivated admin can't drop the active-admin count below the minimum.
  const targetUser = await ctx.userStore.get(userId);
  if (!targetUser?.deletedAt && (await activeAdminCount(members, ctx.userStore)) <= 1) {
    return { content: textContent(message), isError: true };
  }
  return null;
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
    // Only guard when the target is an active admin — removing an already
    // deactivated admin can't drop the active-admin count below the minimum.
    const targetUser = await ctx.userStore.get(userId);
    if (!targetUser?.deletedAt && (await activeAdminCount(ws.members, ctx.userStore)) <= 1) {
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
    if (err instanceof PersonalWorkspaceInvariantError) {
      return personalWorkspaceInvariantToolResult(err);
    }
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
    const guard = await lastActiveAdminGuard(
      ctx,
      ws.members,
      userId,
      "Cannot demote the last workspace admin.",
    );
    if (guard) return guard;
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
    return mutationErrorResult(err, "update member");
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

  // Enrich members with display names and emails from user profiles. Deactivated
  // (soft-deleted) members keep their membership for clean restore, so surface
  // deletedAt here too — the member still appears, flagged, rather than as a
  // normal member (the second of the two surfaces the soft-delete fix targets).
  const enrichedMembers = await Promise.all(
    ws.members.map(async (m) => {
      const user = await ctx.userStore.get(m.userId);
      return {
        userId: m.userId,
        role: m.role,
        displayName: user?.displayName ?? m.userId,
        email: user?.email ?? "",
        ...(user?.deletedAt ? { deletedAt: user.deletedAt } : {}),
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
