// ---------------------------------------------------------------------------
// Workspace ordering
//
// Sidebar order rule: alphabetically by display name. Nothing lifts a
// workspace out of order — not its name, not the viewer's role in it — so a
// workspace stays where a member learned it.
//
// Pure, deterministic, no I/O, so every workspace list (the switcher, the
// palette, where `/` falls back to) shares one order.
// ---------------------------------------------------------------------------

import type { WorkspaceInfo } from "../context/WorkspaceContext";

/**
 * Return a new array ordered case-insensitively by `name`. Ties (same name)
 * break by `id` for determinism.
 */
export function orderWorkspacesForSidebar(workspaces: readonly WorkspaceInfo[]): WorkspaceInfo[] {
  return [...workspaces].sort(compareWorkspacesForSidebar);
}

function compareWorkspacesForSidebar(a: WorkspaceInfo, b: WorkspaceInfo): number {
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}
