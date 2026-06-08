/**
 * Workspace-scoped write authorization — the single source of truth.
 *
 * STRICT policy: a workspace-scoped write is allowed iff the operator is an
 * authenticated user who is a member of the target workspace with the
 * `admin` member role. Org role (`orgRole`) grants NO bypass — an org
 * admin/owner who is not a workspace admin member cannot write workspace
 * content. This mirrors the existing skills behavior and the HTTP
 * `resolveWorkspace` middleware, which already requires membership.
 *
 * Pure (no I/O): callers fetch the `Workspace` and pass it in. The
 * structured `WorkspaceWriteDecision` lets each call site adapt to its own
 * return convention (`PermissionDecision`, `ToolResult`, or `boolean`).
 */

import type { UserIdentity } from "../identity/provider.ts";
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
  identity: UserIdentity | null | undefined,
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
