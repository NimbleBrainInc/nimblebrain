import type { WorkspaceInfo } from "../context/WorkspaceContext";

/**
 * Recover from a `workspace_error` — the active `X-Workspace-Id` was rejected
 * by the server (deleted workspace, lost membership, or an inaccessible
 * `/w/:slug` deep-link). Pick a valid fallback workspace and route home so the
 * shell drops the bad selection instead of surfacing raw error JSON.
 *
 * The rejected (currently-active) workspace is EXCLUDED from candidates. The
 * failing id is exactly what's in the header, and the client's cached list can
 * be stale — still listing a workspace the server now rejects — so re-selecting
 * it would just refetch with the same bad header and strand the user on a home
 * view that can't load data. Prefer the personal workspace, then any other
 * membership. When nothing valid remains, bail and let bootstrap / login own
 * the empty-membership case rather than loop.
 *
 * Side effects (`setActiveWorkspace`, `navigateHome`) are injected so this is
 * unit-testable without rendering the shell.
 */
export function recoverFromWorkspaceError(
  workspaces: WorkspaceInfo[],
  rejectedId: string | undefined,
  setActiveWorkspace: (ws: WorkspaceInfo) => void,
  navigateHome: () => void,
): void {
  const fallback =
    workspaces.find((w) => w.isPersonal && w.id !== rejectedId) ??
    workspaces.find((w) => w.id !== rejectedId) ??
    null;
  if (!fallback) return;
  // setActiveWorkspace syncs the api/client header + localStorage.
  setActiveWorkspace(fallback);
  navigateHome();
}
