import { useMemo } from "react";
import { type SessionInfo, useSession } from "../context/SessionContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../context/WorkspaceContext";

/**
 * The signed-in user's effective role across the platform's three scopes.
 *
 *   none       — not signed in (or session not yet loaded)
 *   ws_member  — member of the active workspace, no admin powers
 *   ws_admin   — workspace admin OR org admin/owner (effective workspace-level *reach* — see the note below; this is NOT edit rights)
 *   org_admin  — org admin (manage all users, all workspaces)
 *   org_owner  — org owner (superset of org_admin)
 *
 * Org owners and admins are always treated as ws_admin for any workspace.
 * The hook returns the *highest* role that applies — gates check `>=` against
 * a required minimum, not equality, so org owners pass workspace-admin checks
 * automatically.
 *
 * **That escalation is for reach, not for writes.** It answers "may this user
 * get to this surface" — navigation, route guards, read gates — where an org
 * admin legitimately reaches every workspace. It does NOT answer "may this user
 * write this workspace": the server's `canWriteWorkspaceScoped`
 * (`src/workspace/authz.ts`) requires membership with `role === "admin"` and
 * never consults `orgRole`. Gate writes with `canWriteWorkspace` below — read
 * its doc before picking a form, because which workspace you are asking about
 * matters; `roleAtLeast(role, "ws_admin")` would offer controls the server
 * refuses.
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

/**
 * "May this user write this workspace" — the whole rule, in one place.
 *
 * Mirrors the server's `canWriteWorkspaceScoped` term for term: a member whose
 * membership role is `admin`. `undefined` means not a member, which denies for
 * the same reason the server does.
 *
 * Takes the **membership role**, not a `ScopedRole` and not a workspace.
 * Routing it through the role ordering is what lets an org admin past a gate
 * the server refuses (see the `ScopedRole` doc above); taking a role rather
 * than the *active* workspace is what lets a surface addressing a workspace by
 * id use the same rule instead of writing its own. See
 * `useCanWriteActiveWorkspace` for when each form applies.
 */
export function canWriteWorkspace(membershipRole: WorkspaceInfo["userRole"]): boolean {
  return membershipRole === "admin";
}

/**
 * Whether the signed-in user may write **the active workspace**.
 *
 * Use this on a surface scoped to the active workspace — anything under
 * `/w/:slug`, where `WorkspaceRouteGuard` has made `activeWorkspace` agree with
 * the route. A surface that addresses a workspace **by id** (`/org/workspaces/
 * :slug`) must not use it: `activeWorkspace` there is the viewer's last-focused
 * workspace, which defaults to their personal one — where they are always admin
 * by store invariant — so this would return `true` for everyone. Call
 * `canWriteWorkspace(role)` with that workspace's membership role instead.
 *
 * Use `useScopedRole` + `roleAtLeast` for reach: navigation, route guards, and
 * org-scoped checks.
 *
 * A personal workspace needs no special case — the store force-locks its
 * members to `[{ userId: ownerUserId, role: "admin" }]`, so its owner always
 * passes here.
 */
export function useCanWriteActiveWorkspace(): boolean {
  const { activeWorkspace } = useWorkspaceContext();
  return canWriteWorkspace(activeWorkspace?.userRole);
}
