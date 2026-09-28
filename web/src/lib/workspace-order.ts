// ---------------------------------------------------------------------------
// Workspace ordering
//
// Sidebar order rule: workspaces alphabetically by display name. Every
// workspace is ordinary, so none sorts ahead of the others.
//
// Pure, deterministic, no I/O. Reusable across sidebar + composer footer
// + any future workspace-list surface that wants the same ordering.
// ---------------------------------------------------------------------------

import type { WorkspaceInfo } from "../context/WorkspaceContext";

/**
 * Return a new array with workspaces ordered case-insensitively by `name`.
 * Ties (same name) break by `id` for determinism.
 */
export function orderWorkspacesForSidebar(workspaces: readonly WorkspaceInfo[]): WorkspaceInfo[] {
  return [...workspaces].sort(compareWorkspacesForSidebar);
}

function compareWorkspacesForSidebar(a: WorkspaceInfo, b: WorkspaceInfo): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}
