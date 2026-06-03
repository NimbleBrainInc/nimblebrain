// ---------------------------------------------------------------------------
// Bootstrap mappers — server response → client context state
//
// `userRole` is load-bearing: it drives every workspace-scoped permission
// gate via `useScopedRole`. Dropping it on the way through resolves any
// non-org-admin member to role="none" and filters their settings nav down
// to "About" only — a bug we shipped once and won't ship again. Anchor
// the mapping in tested helpers so a future contributor can't accidentally
// re-introduce the omission via either entry path (bootstrap response or
// `manage_workspaces.list` fallback).
// ---------------------------------------------------------------------------

import type { WorkspaceInfo } from "../context/WorkspaceContext";
import type { BootstrapResponse } from "../types";

/**
 * Convert the bootstrap response's per-workspace shape into the
 * `WorkspaceInfo` the `WorkspaceProvider` consumes. Caller is expected to
 * pass `bootstrap.workspaces` directly. `bundles` starts empty and is
 * populated lazily; `userRole` propagates so role gating works.
 */
export function bootstrapWorkspacesToInfo(
  workspaces: BootstrapResponse["workspaces"],
): WorkspaceInfo[] {
  return workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    memberCount: ws.memberCount,
    bundles: [],
    userRole: ws.role,
    // `isPersonal` flows through unchanged from bootstrap. The shell uses
    // it to badge the personal workspace and to enforce the personal-
    // workspace invariants in workspace settings. Pre-Stage-1 deployments
    // return `false` for every workspace.
    isPersonal: ws.isPersonal,
  }));
}

/**
 * Parse the `manage_workspaces.list` tool response into `WorkspaceInfo[]`.
 * Used by the WorkspaceProvider's fallback fetch path (when bootstrap data
 * isn't provided — e.g. tests, hot-reload, or a future code path that
 * bypasses bootstrap).
 *
 * Defensive about field naming: the bootstrap response uses `role`, while
 * this tool returns `userRole` directly. Accept either so either contract
 * change can land without silently dropping the role and re-introducing
 * the "settings nav shows About only" regression.
 *
 * Tolerates either `[{...}]` or `{ workspaces: [{...}] }` envelopes.
 */
export function parseWorkspaceListResponse(raw: unknown): WorkspaceInfo[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && "workspaces" in raw && Array.isArray(raw.workspaces)
      ? raw.workspaces
      : [];

  return list
    .filter((ws): ws is Record<string, unknown> => ws != null && typeof ws === "object")
    .map((ws) => {
      const rawRole = ws.userRole ?? ws.role;
      const userRole = rawRole === "admin" || rawRole === "member" ? rawRole : undefined;
      return {
        id: String(ws.id ?? ""),
        name: String(ws.name ?? ""),
        memberCount: typeof ws.memberCount === "number" ? ws.memberCount : 0,
        bundles: Array.isArray(ws.bundles)
          ? (ws.bundles as Array<{ name?: string; path?: string }>)
          : [],
        ...(userRole ? { userRole } : {}),
        // Pass through `isPersonal` from either contract. Bootstrap
        // returns it directly; `manage_workspaces.list` surfaces it too.
        // It no longer gates connector installs (every workspace is a
        // valid target) — it only marks the sole-owner workspace for
        // display. Missing field degrades to "not identified as personal."
        ...(typeof ws.isPersonal === "boolean" ? { isPersonal: ws.isPersonal } : {}),
      };
    });
}
