import { useMemo } from "react";
import { type SessionInfo, useSession } from "../context/SessionContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../context/WorkspaceContext";

/**
 * The signed-in user's effective role across the platform's three scopes.
 *
 *   none       — not signed in (or session not yet loaded)
 *   ws_member  — member of the active workspace, no admin powers
 *   ws_admin   — workspace admin OR org admin/owner (effective workspace-level edit rights)
 *   org_admin  — org admin (manage all users, all workspaces)
 *   org_owner  — org owner (superset of org_admin)
 *
 * Org owners and admins are always treated as ws_admin for any workspace.
 * The hook returns the *highest* role that applies — gates check `>=` against
 * a required minimum, not equality, so org owners pass workspace-admin checks
 * automatically.
 */
export type ScopedRole = "none" | "ws_member" | "ws_admin" | "org_admin" | "org_owner";

const ROLE_ORDER: ScopedRole[] = ["none", "ws_member", "ws_admin", "org_admin", "org_owner"];

/** True when `role` meets or exceeds `required`. */
export function roleAtLeast(role: ScopedRole, required: ScopedRole): boolean {
  return ROLE_ORDER.indexOf(role) >= ROLE_ORDER.indexOf(required);
}

/**
 * Pure resolution from session + active workspace → scoped role. Exported
 * for unit testing. The hook is a trivial reactive wrapper.
 */
export function resolveScopedRole(
  session: SessionInfo | null,
  activeWorkspace: WorkspaceInfo | null,
): ScopedRole {
  const orgRole = session?.user?.orgRole;
  if (orgRole === "owner") return "org_owner";
  if (orgRole === "admin") return "org_admin";

  if (!session?.authenticated) return "none";

  // No org-admin powers — fall back to workspace-level role for the
  // active workspace. `userRole` comes from the extended workspace list
  // payload; `undefined` means the user isn't a member of this workspace.
  const wsRole = activeWorkspace?.userRole;
  if (wsRole === "admin") return "ws_admin";
  if (wsRole === "member") return "ws_member";

  return "none";
}

/**
 * Resolve the user's role for the active workspace (or org-only when no
 * workspace context is needed).
 *
 * Reads from `SessionContext` (org role) and `WorkspaceContext` (active
 * workspace + the user's membership role within it, populated by the
 * extended `manage_workspaces.list` response). No async fetches — the
 * inputs are already in memory.
 */
export function useScopedRole(): ScopedRole {
  const session = useSession();
  const { activeWorkspace } = useWorkspaceContext();
  return useMemo(() => resolveScopedRole(session, activeWorkspace), [session, activeWorkspace]);
}
