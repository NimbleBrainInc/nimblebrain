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
// Each workspace row: avatar (deterministic letter+color), workspace
// name, role badge. One click target. Click = setActiveWorkspace +
// navigate to `/w/<slug>/`.
//
// Under the FOCUSED workspace (the one matching `activeWorkspace`, whose
// placements the shell context holds) we render a quick-access list of
// its top apps — see `WorkspaceInlineApps`. This is the Notion/Linear
// "teamspace → pages" tree, still not the Discord rail (the section is a
// sibling of the global nav, not a parent column). Capped at
// `MAX_INLINE_APPS`; an overflow "View all N apps" link routes to the
// workspace overview page (the full grid). No pinning / recency yet —
// it's a priority-ordered top-N. Other rows stay collapsed (their
// placements aren't loaded).
//
// The `+` affordance on the section heading routes to the existing
// org-workspaces page (no new UX invented).
// ---------------------------------------------------------------------------

import { ArrowRight, Plus } from "lucide-react";
import { Fragment, useCallback, useMemo } from "react";
import { Link, matchPath, useLocation, useNavigate } from "react-router-dom";
import { useShellContext } from "../../context/ShellContext";
import { useWorkspaceAppIcons } from "../../context/WorkspaceAppIconsContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { cn } from "../../lib/utils";
import { MAX_INLINE_APPS, workspaceApps } from "../../lib/workspace-apps";
import { getWorkspaceAvatar } from "../../lib/workspace-avatar";
import { orderWorkspacesForSidebar } from "../../lib/workspace-order";
import { toSlug } from "../../lib/workspace-slug";
import { ConnectorIcon } from "../connectors/ConnectorIcon";

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
          <div className="text-2xs font-bold tracking-[0.08em] text-sidebar-foreground/60 uppercase">
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
            <Plus className="size-3.5" />
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
            <Fragment key={ws.id}>
              <WorkspaceItem
                workspace={ws}
                isActive={activeRouteSlug === toSlug(ws.id)}
                onSelect={() => handleSelect(ws)}
                collapsed={collapsed}
              />
              {/* Inline app quick-list under the focused workspace only.
                  `activeWorkspace` is whose placements the shell context
                  holds; rendering it under any other row would show the
                  wrong workspace's apps. Hidden in collapsed (icon-only)
                  mode — there's no room for labels. */}
              {!collapsed && ws.id === wsCtx.activeWorkspace?.id && (
                <WorkspaceInlineApps workspaceId={ws.id} />
              )}
            </Fragment>
          ))}
    </div>
  );
}

// Quick-access list of the focused workspace's top apps, rendered under
// its row. App set + ordering come from the shell placement registry
// (same source as the overview grid, via `workspaceApps`); brand icons
// come from `useWorkspaceAppIcons` with a letter-avatar fallback. The
// workspace is already active here, so each app is a plain `<Link>` into
// `/w/<slug>/app/<route>` (no setActiveWorkspace dance needed).
function WorkspaceInlineApps({ workspaceId }: { workspaceId: string }) {
  const shell = useShellContext();
  const { iconFor } = useWorkspaceAppIcons();
  const location = useLocation();
  const slug = toSlug(workspaceId);

  // Only show apps once the shell's placements reflect THIS workspace.
  // The shell holds one workspace's placements at a time and lags a
  // switch (see ShellContext.shellWorkspaceId), so without this gate a
  // switch would briefly paint the previous workspace's apps under the
  // newly-focused row. Mirrors the overview grid's readiness check.
  const ready = shell != null && shell.shellWorkspaceId === workspaceId;
  const apps = useMemo(
    () => (ready && shell ? workspaceApps(shell.forSlot("sidebar")) : []),
    [ready, shell],
  );

  if (apps.length === 0) return null;
  const shown = apps.slice(0, MAX_INLINE_APPS);
  const hasOverflow = apps.length > shown.length;

  return (
    <div
      className="ml-4 mr-2 mb-1 mt-px flex flex-col border-l border-sidebar-foreground/10 pl-1"
      data-testid="sidebar-workspace-apps"
      data-app-count={apps.length}
    >
      {shown.map((p) => {
        const label = p.label ?? p.route ?? "App";
        const target = `/w/${slug}/app/${p.route}`;
        // Exact match, not startsWith: app routes are leaf paths (App.tsx
        // registers `app/<route>` with no splat), so the current URL maps to
        // exactly one placement. startsWith would mis-light a `crm` row when
        // viewing a sibling `crm-archive` (string prefix) or a `crm/board`
        // sub-view.
        const isActive = !!p.route && location.pathname === target;
        return (
          <Link
            key={p.resourceUri}
            to={target}
            title={label}
            data-testid="sidebar-workspace-app"
            data-app-route={p.route ?? ""}
            data-is-active={isActive ? "true" : "false"}
            className={cn(
              "flex items-center gap-2 text-sm transition-colors rounded-md px-2 py-1",
              isActive
                ? "bg-sidebar-foreground/10 text-sidebar-foreground"
                : "text-sidebar-foreground/80 hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground",
            )}
          >
            <ConnectorIcon
              name={label}
              iconUrl={iconFor(p.serverName)}
              className="size-[18px] rounded-sm text-3xs"
            />
            <span className="flex-1 truncate">{label}</span>
          </Link>
        );
      })}
      {hasOverflow && (
        <Link
          to={`/w/${slug}/`}
          data-testid="sidebar-workspace-view-all"
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
        >
          <ArrowRight className="size-3 shrink-0" />
          <span className="truncate">View all {apps.length} apps</span>
        </Link>
      )}
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
        className="size-[18px] shrink-0 flex items-center justify-center rounded-md text-white text-3xs font-semibold"
        style={{ backgroundColor: avatar.color }}
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
