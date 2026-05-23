// ---------------------------------------------------------------------------
// WorkspaceAppList — Stage 2 / T013
//
// Indented list of installed apps under a single workspace row in the
// sidebar navigator. Each app row, when clicked:
//
//   1. Calls `setActiveWorkspace(ws)` IF the active workspace differs.
//      The `setActiveWorkspaceId` setter inside that hook is itself
//      equality-guarded (T009: a no-op on same id, does NOT fire the
//      bridge reset hook). This boundary is the structural guard
//      against "every app click invalidates the REST cache".
//
//   2. Navigates to `/w/<slug>/app/<bundle-name>` — the existing
//      placement convention (see App.tsx::handleNavigate). We use the
//      bundle's `name` as the route segment because placements may not
//      have loaded for non-active workspaces yet; the convention
//      `route === bundle.name` is honored by the router via
//      `path="app/${route}"`.
//
//   3. Persists the selection via localStorage so a reload restores
//      the user's last-viewed workspace+app. Key `nb:last-viewed-app`
//      is separate from `nb_active_workspace` (WorkspaceContext owns
//      that) so a reload remembers BOTH the workspace AND the app
//      within it.
//
// Active workspace's apps render with a distinct selected style;
// non-active workspace apps render in the same indented list but
// without selection state until they're clicked.
// ---------------------------------------------------------------------------

import { useNavigate } from "react-router-dom";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { toSlug } from "../../lib/workspace-slug";
import { cn } from "../../lib/utils";

const LAST_VIEWED_APP_KEY = "nb:last-viewed-app";

interface WorkspaceAppListProps {
  workspace: WorkspaceInfo;
  /** Bundle name of the currently-selected app, when this workspace is active. */
  selectedAppRoute: string | null;
}

export function WorkspaceAppList({ workspace, selectedAppRoute }: WorkspaceAppListProps) {
  const wsCtx = useWorkspaceContext();
  const navigate = useNavigate();
  const bundles = workspace.bundles;

  if (bundles.length === 0) {
    return (
      <div
        className="pl-8 pr-3 py-1.5 text-xs text-sidebar-foreground/50 italic"
        data-testid="workspace-app-list-empty"
        data-workspace-id={workspace.id}
      >
        No apps installed
      </div>
    );
  }

  const handleSelect = (bundleName: string) => {
    // Equality guard at the React layer — only call setActiveWorkspace
    // when the active workspace differs. WorkspaceContext.setActiveWorkspace
    // calls api/client.setActiveWorkspaceId which also no-ops on same id
    // (T009 invariant). Double-guarding here keeps the topology
    // tests honest: a regression that re-fires the setter on every
    // app click would show up as an extra invocation count in the
    // spec's adversarial test.
    if (wsCtx.activeWorkspace?.id !== workspace.id) {
      wsCtx.setActiveWorkspace(workspace);
    }
    try {
      localStorage.setItem(LAST_VIEWED_APP_KEY, `${workspace.id}:${bundleName}`);
    } catch {
      // localStorage may be unavailable (private mode, quota)
    }
    const slug = toSlug(workspace.id);
    navigate(`/w/${slug}/app/${bundleName}`);
  };

  return (
    <div
      className="flex flex-col"
      data-testid="workspace-app-list"
      data-workspace-id={workspace.id}
    >
      {bundles.map((bundle) => {
        const name = bundle.name;
        if (!name) return null;
        const isSelected = wsCtx.activeWorkspace?.id === workspace.id && selectedAppRoute === name;
        return (
          <button
            key={name}
            type="button"
            onClick={() => handleSelect(name)}
            data-testid="workspace-app-row"
            data-workspace-id={workspace.id}
            data-app-route={name}
            data-selected={isSelected ? "true" : "false"}
            className={cn(
              "flex items-center gap-2 pl-8 pr-3 py-1.5 mx-2 rounded-md text-sm transition-colors text-left",
              isSelected
                ? "bg-sidebar-foreground/10 text-sidebar-foreground font-medium"
                : "text-sidebar-foreground/80 hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground",
            )}
          >
            <span className="truncate">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Read the persisted last-viewed app, if any. Returned shape is
 * `{ workspaceId, appRoute }` or `null`. Exposed so the shell can
 * restore selection on mount.
 */
export function readLastViewedApp(): { workspaceId: string; appRoute: string } | null {
  try {
    const raw = localStorage.getItem(LAST_VIEWED_APP_KEY);
    if (!raw) return null;
    const idx = raw.indexOf(":");
    if (idx <= 0) return null;
    const workspaceId = raw.slice(0, idx);
    const appRoute = raw.slice(idx + 1);
    if (!workspaceId || !appRoute) return null;
    return { workspaceId, appRoute };
  } catch {
    return null;
  }
}

export const LAST_VIEWED_APP_STORAGE_KEY = LAST_VIEWED_APP_KEY;
