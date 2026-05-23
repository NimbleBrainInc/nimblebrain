// ---------------------------------------------------------------------------
// Workspace ordering — Stage 2 / T013
//
// Sidebar order rule (per task spec acceptance criterion):
//   "Personal first, then shared workspaces alphabetically by display name."
//
// `isPersonal` is the truth signal (Stage 1 invariant — personal workspaces
// are sole-owner-by-design and carry `isPersonal === true`). When the field
// is missing on legacy entries the workspace is treated as shared, matching
// the bootstrap mapper's degradation contract.
//
// Pure, deterministic, no I/O. Reusable across sidebar + composer footer
// + any future workspace-list surface that wants the same ordering.
// ---------------------------------------------------------------------------

import type { WorkspaceInfo } from "../context/WorkspaceContext";

/**
 * Return a new array with workspaces ordered: personal first (single
 * entry expected per identity but the comparator stays total), then
 * shared workspaces ordered case-insensitively by `name`. Ties (same
 * name) break by `id` for determinism.
 */
export function orderWorkspacesForSidebar(workspaces: readonly WorkspaceInfo[]): WorkspaceInfo[] {
  return [...workspaces].sort(compareWorkspacesForSidebar);
}

function compareWorkspacesForSidebar(a: WorkspaceInfo, b: WorkspaceInfo): number {
  const aPersonal = a.isPersonal === true ? 0 : 1;
  const bPersonal = b.isPersonal === true ? 0 : 1;
  if (aPersonal !== bPersonal) return aPersonal - bPersonal;
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}
