// ---------------------------------------------------------------------------
// WorkspaceSection — labelled WORKSPACES list inside the main sidebar
//
// IA argument: Conversations / Automations / Files / Home are global
// (identity-bound, cross-workspace). Workspaces are a sibling category,
// not a parent column. A vertical sidebar with a labelled section
// (Linear's "Workspaces" / Notion's "Teamspaces" / Things' "Areas"
// pattern) signals "different kind of thing in this list" without
// implying parent/child. Putting workspaces in a left rail — even
// without inline apps — borrowed the Discord/Slack pattern where the
// rail IS a parent column; that mismatch broke the metaphor here.
//
// Each row: avatar (deterministic letter+color), workspace name, role
// badge. One click target. Click = setActiveWorkspace + navigate to
// `/w/<slug>/`. No expand toggle, no inline apps. App discovery lives
// on the workspace overview page.
//
// The `+` affordance on the section heading routes to the existing
// org-workspaces page (no new UX invented).
// ---------------------------------------------------------------------------

import { Plus } from "lucide-react";
import { useCallback, useMemo } from "react";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { cn } from "../../lib/utils";
import { getWorkspaceAvatar } from "../../lib/workspace-avatar";
import { orderWorkspacesForSidebar } from "../../lib/workspace-order";
import { toSlug } from "../../lib/workspace-slug";

interface WorkspaceSectionProps {
  /**
   * Collapsed sidebar = icon-only mode. In that mode we render avatars
   * only (no labels, no header, no `+` affordance), matching the
   * collapsed look of NavItem in the surrounding sidebar.
   */
  collapsed?: boolean;
}

export function WorkspaceSection({ collapsed = false }: WorkspaceSectionProps) {
  const wsCtx = useWorkspaceContext();
  const navigate = useNavigate();
  const location = useLocation();
  const ordered = useMemo(() => orderWorkspacesForSidebar(wsCtx.workspaces), [wsCtx.workspaces]);

  // The active marker follows the ROUTE, not the persisted active
  // workspace. `activeWorkspace` is always set (it scopes tool dispatch),
  // so keying the highlight off it lit a workspace row even on global
  // routes like `/` (Home) or `/conversations` — two items active at
  // once. A workspace row is "active" only when the current path is
  // within that workspace (`/w/<slug>/...`), mirroring how the core
  // NavLinks derive active state from the URL.
  const activeRouteSlug = useMemo(
    () => matchPath({ path: "/w/:slug", end: false }, location.pathname)?.params.slug ?? null,
    [location.pathname],
  );

  const handleSelect = useCallback(
    (ws: WorkspaceInfo) => {
      // React-layer equality guard mirrors the api/client setter's
      // T009 invariant: re-click on the active workspace is a no-op
      // for setActiveWorkspaceId (it does NOT fire the bridge reset
      // hook). The double-guard keeps topology tests honest.
      if (wsCtx.activeWorkspace?.id !== ws.id) {
        wsCtx.setActiveWorkspace(ws);
      }
      navigate(`/w/${toSlug(ws.id)}/`);
    },
    [wsCtx, navigate],
  );

  const handleAddWorkspace = useCallback(() => {
    navigate("/org/workspaces");
  }, [navigate]);

  if (wsCtx.loading) {
    return (
      <div
        className={cn(
          "text-xs text-sidebar-foreground/50",
          collapsed ? "px-2 py-2 text-center" : "px-4 py-2",
        )}
        data-testid="sidebar-workspace-section-loading"
      >
        {collapsed ? "…" : "Loading workspaces…"}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col mt-3"
      data-testid="sidebar-workspace-section"
      data-workspace-count={ordered.length}
      data-collapsed={collapsed ? "true" : "false"}
    >
      {!collapsed && (
        <div className="flex items-center justify-between px-4 pt-1 pb-1">
          <div className="text-[11px] font-bold tracking-[0.08em] text-sidebar-foreground/70 uppercase">
            Workspaces
          </div>
          <button
            type="button"
            onClick={handleAddWorkspace}
            aria-label="Add workspace"
            title="Add workspace"
            data-testid="sidebar-workspace-add"
            className="p-1 rounded-md text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-foreground/10 transition-colors"
          >
            <Plus style={{ width: 14, height: 14 }} />
          </button>
        </div>
      )}

      {ordered.length === 0
        ? !collapsed && (
            <div
              className="px-4 py-2 text-xs text-sidebar-foreground/50 italic"
              data-testid="sidebar-workspace-section-empty"
            >
              No workspaces
            </div>
          )
        : ordered.map((ws) => (
            <WorkspaceItem
              key={ws.id}
              workspace={ws}
              isActive={activeRouteSlug === toSlug(ws.id)}
              onSelect={() => handleSelect(ws)}
              collapsed={collapsed}
            />
          ))}
    </div>
  );
}

function WorkspaceItem({
  workspace,
  isActive,
  onSelect,
  collapsed,
}: {
  workspace: WorkspaceInfo;
  isActive: boolean;
  onSelect: () => void;
  collapsed: boolean;
}) {
  const avatar = getWorkspaceAvatar(workspace);
  const role = workspace.userRole;
  const label = role ? `${workspace.name} (${role})` : workspace.name;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={collapsed ? label : undefined}
      aria-current={isActive ? "page" : undefined}
      // Title set in both modes so the role surfaces on hover even
      // when the name is visible inline (we no longer render the
      // role pill — hover/screen-reader is now its discovery path).
      title={label}
      data-testid="sidebar-workspace-row"
      data-workspace-id={workspace.id}
      data-is-active={isActive ? "true" : "false"}
      data-is-personal={workspace.isPersonal === true ? "true" : "false"}
      className={cn(
        "flex items-center text-sm transition-colors text-left rounded-md mx-2 my-px",
        collapsed ? "justify-center p-1.5" : "gap-2 px-3 py-1.5",
        isActive
          ? "bg-sidebar-foreground/10 text-sidebar-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-foreground/5",
      )}
    >
      <span
        aria-hidden="true"
        data-testid="workspace-avatar"
        className="shrink-0 flex items-center justify-center rounded-md text-white text-[10px] font-semibold"
        style={{ width: 18, height: 18, backgroundColor: avatar.color }}
      >
        {avatar.letter}
      </span>
      {/* Role is intentionally not rendered inline — it adds visual
          noise in a tight list. It still flows into `aria-label` /
          `title` for hover + screen readers, and surfaces on the
          workspace overview page where there's room for it. */}
      {!collapsed && <span className="flex-1 truncate font-medium">{workspace.name}</span>}
    </button>
  );
}
