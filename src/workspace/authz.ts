/**
 * Workspace-scoped write authorization — the single source of truth.
 *
 * STRICT policy: a workspace-scoped write is allowed iff the operator is an
 * authenticated user who is a member of the target workspace with the
 * `admin` member role. Org role (`orgRole`) grants NO bypass — an org
 * admin who is not a workspace admin member cannot write workspace
 * content. This mirrors the existing skills behavior and the HTTP
 * `requireWorkspace` middleware, which already requires membership.
 *
 * Governance is the exception, decided by `canManageWorkspaceMembers` below:
 * who may reach a workspace, and what it is called, are org concerns, so an
 * org admin governs them without being a member. Reading the roster is open
 * to every member (`canReadWorkspaceMembers`).
 *
 * Pure (no I/O): callers fetch the `Workspace` and pass it in. The
 * structured `WorkspaceWriteDecision` lets each call site adapt to its own
 * return convention (`PermissionDecision`, `ToolResult`, or `boolean`).
 */

import type { UserIdentity } from "../identity/provider.ts";
import { ORG_ADMIN_ROLES } from "../identity/types.ts";
import type { Workspace } from "./types.ts";

/** Outcome of a workspace-scoped write authorization check. */
export type WorkspaceWriteDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Decide whether `identity` may perform a workspace-scoped write in `ws`.
 *
 * Allowed only when the user is a workspace member with `role === "admin"`.
 * `orgRole` is deliberately never consulted — there is no org-admin bypass
 * for workspace-scoped writes.
 */
export function canWriteWorkspaceScoped(
  identity: Pick<UserIdentity, "id"> | null | undefined,
  ws: Workspace | null | undefined,
): WorkspaceWriteDecision {
  if (!identity) {
    return { allowed: false, reason: "Not authenticated" };
  }
  if (!ws) {
    return { allowed: false, reason: "Workspace not found" };
  }

  // Fail closed on a malformed workspace record: a non-array `members`
  // is treated as "no members" → not a member → deny, rather than
  // throwing. Preserves the defensive posture authorization helpers need.
  if (!Array.isArray(ws.members)) {
    return { allowed: false, reason: `Not a member of workspace "${ws.id}"` };
  }

  const member = ws.members.find((m) => m.userId === identity.id);
  if (!member) {
    return { allowed: false, reason: `Not a member of workspace "${ws.id}"` };
  }
  if (member.role !== "admin") {
    return {
      allowed: false,
      reason: `Workspace-scope writes require workspace admin in "${ws.id}"`,
    };
  }

  return { allowed: true };
}

/**
 * Decide whether `identity` may manage `ws`'s membership: list, add, remove,
 * and change the role of its members.
 *
 * Membership is access governance, not workspace content, so it is decided at
 * org scope as well as workspace scope: an org admin may manage the
 * members of any workspace, as they may create or delete it, and a workspace
 * admin member may manage their own. Content writes stay with
 * `canWriteWorkspaceScoped`; an org admin who wants to write content seats
 * themselves as a member first, which shows in the roster and in the
 * member-change log.
 */
export function canManageWorkspaceMembers(
  identity: Pick<UserIdentity, "id" | "orgRole"> | null | undefined,
  ws: Workspace | null | undefined,
): WorkspaceWriteDecision {
  if (identity && ws && ORG_ADMIN_ROLES.has(identity.orgRole)) {
    return { allowed: true };
  }
  return canWriteWorkspaceScoped(identity, ws);
}

/**
 * Decide whether `identity` may rename `ws`.
 *
 * A workspace's name, like its roster, is governance rather than content: the
 * workspace's own admins and an org admin decide it, as they decide who
 * belongs. So the rule is `canManageWorkspaceMembers`'. Its connector list stays
 * with org admins (`manage_workspaces update` with `connectors`).
 */
export function canRenameWorkspace(
  identity: Pick<UserIdentity, "id" | "orgRole"> | null | undefined,
  ws: Workspace | null | undefined,
): WorkspaceWriteDecision {
  return canManageWorkspaceMembers(identity, ws);
}

/**
 * Decide whether `identity` may read `ws`'s roster: who its members are and
 * their roles.
 *
 * Any member may, as they share the workspace with everyone on it, and so may
 * an org admin, who may manage it. Changing the roster stays with
 * `canManageWorkspaceMembers`.
 */
export function canReadWorkspaceMembers(
  identity: Pick<UserIdentity, "id" | "orgRole"> | null | undefined,
  ws: Workspace | null | undefined,
): WorkspaceWriteDecision {
  if (!identity) return { allowed: false, reason: "Not authenticated" };
  if (!ws) return { allowed: false, reason: "Workspace not found" };
  if (ORG_ADMIN_ROLES.has(identity.orgRole)) return { allowed: true };
  if (Array.isArray(ws.members) && ws.members.some((m) => m.userId === identity.id)) {
    return { allowed: true };
  }
  return { allowed: false, reason: `Not a member of workspace "${ws.id}"` };
}
