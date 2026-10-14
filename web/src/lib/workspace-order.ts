// ---------------------------------------------------------------------------
// Workspace ordering
//
// Sidebar order rule: the viewer's pinned workspaces first, then the rest;
// each group alphabetically by display name. Nothing else lifts a workspace
// out of order — not its name, not the viewer's role in it.
//
// Pure, deterministic, no I/O. The pinned set is passed in (see
// `lib/pinned-workspaces.ts`), so this stays reusable across the sidebar, the
// home grid, and any future workspace-list surface that wants the same order.
// ---------------------------------------------------------------------------

import type { WorkspaceInfo } from "../context/WorkspaceContext";

/**
 * Return a new array with pinned workspaces first, each group ordered
 * case-insensitively by `name`. Ties (same name) break by `id` for determinism.
 */
export function orderWorkspacesForSidebar(
  workspaces: readonly WorkspaceInfo[],
  pinned: ReadonlySet<string> = new Set(),
): WorkspaceInfo[] {
  return [...workspaces].sort(
    (a, b) =>
      Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || compareWorkspacesForSidebar(a, b),
  );
}

function compareWorkspacesForSidebar(a: WorkspaceInfo, b: WorkspaceInfo): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}
