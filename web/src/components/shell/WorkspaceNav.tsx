// ---------------------------------------------------------------------------
// WorkspaceNav — the workspace tree (the whole left-nav body).
//
// A single labelled WORKSPACES list. Each workspace is a disclosure row; the
// FOCUSED workspace is expanded and the rest collapse to one row. Single-expand
// is the point — it mirrors the runtime, which walls every session to exactly
// one workspace at a time, so exactly one workspace is ever open here. The way
// to "see another workspace's stuff" is to focus it (the accordion swings over).
//
// Personal sorts first as the "Home · Personal" row. The focused workspace's
// subtree nests its identity views (Conversations / Automations / Files), then
// its APPS (People, Tasks, … — capped with a View-all overflow), then a
// CONNECTORS row — each routed into `/w/<slug>/…`. The identity views' TOOLS
// still dispatch bare through the identity door (see lib/identity-apps); the
// slug here is the focused workspace = view scope, not a tool namespace.
//
// This replaces the previous "Conversations / Automations / Files are global
// top-level nav, workspaces are a sibling category" arrangement: those views
// are workspace-scoped now (the runtime walls each session to one workspace and
// there is no cross-workspace list), so the UI nests them under the workspace.
// ---------------------------------------------------------------------------

import { ArrowRight, ChevronRight, Home, Plus } from "lucide-react";
import { useCallback, useMemo } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useShellContext } from "../../context/ShellContext";
import { useWorkspaceAppIcons } from "../../context/WorkspaceAppIconsContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { resolveIcon } from "../../lib/icons";
import { identityAppRoute, isIdentityApp } from "../../lib/identity-apps";
import { cn } from "../../lib/utils";
import { MAX_INLINE_APPS, workspaceApps } from "../../lib/workspace-apps";
import { getWorkspaceAvatar } from "../../lib/workspace-avatar";
import { orderWorkspacesForSidebar } from "../../lib/workspace-order";
import { toSlug } from "../../lib/workspace-slug";
import { ConnectorIcon } from "../connectors/ConnectorIcon";

interface WorkspaceNavProps {
  /**
   * Collapsed sidebar = icon-only mode. We render workspace avatars only (no
   * header, no `+`, no expansion): nested rows have no room for labels and an
   * icon-only tree reads as noise. Click an avatar to focus that workspace.
   */
  collapsed?: boolean;
}

export function WorkspaceNav({ collapsed = false }: WorkspaceNavProps) {
  const wsCtx = useWorkspaceContext();
  const navigate = useNavigate();

  const ordered = useMemo(() => orderWorkspacesForSidebar(wsCtx.workspaces), [wsCtx.workspaces]);
  const focusedId = wsCtx.activeWorkspace?.id;

  const handleSelect = useCallback(
    (ws: WorkspaceInfo) => {
      // React-layer equality guard mirrors the api/client setter's T009
      // invariant: re-focusing the active workspace is a no-op for
      // setActiveWorkspaceId (it must not fire the bridge reset hook).
      if (wsCtx.activeWorkspace?.id !== ws.id) wsCtx.setActiveWorkspace(ws);
      // Every workspace opens its own overview — Personal included. Personal is
      // just the workspace labelled "Home · Personal", not a detour through the
      // global landing grid.
      navigate(`/w/${toSlug(ws.id)}/`);
    },
    [wsCtx, navigate],
  );

  const handleAdd = useCallback(() => navigate("/org/workspaces"), [navigate]);

  if (wsCtx.loading) {
    return (
      <div
        className={cn(
          "text-xs text-sidebar-foreground/50",
          collapsed ? "px-2 py-2 text-center" : "px-4 py-2",
        )}
        data-testid="sidebar-workspace-nav-loading"
      >
        {collapsed ? "…" : "Loading workspaces…"}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div
        className="flex flex-col mt-2"
        data-testid="sidebar-workspace-nav"
        data-workspace-count={ordered.length}
        data-collapsed="true"
      >
        {ordered.map((ws) => (
          <WorkspaceAvatarButton
            key={ws.id}
            workspace={ws}
            focused={ws.id === focusedId}
            onSelect={() => handleSelect(ws)}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col mt-3"
      data-testid="sidebar-workspace-nav"
      data-workspace-count={ordered.length}
      data-collapsed="false"
    >
      <div className="flex items-center justify-between px-4 pt-1 pb-1">
        <div className="text-2xs font-bold tracking-[0.08em] text-sidebar-foreground/60 uppercase">
          Workspaces
        </div>
        <button
          type="button"
          onClick={handleAdd}
          aria-label="Add workspace"
          title="Add workspace"
          data-testid="sidebar-workspace-add"
          className="p-1 rounded-sm text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-foreground/10 transition-colors"
        >
          <Plus className="size-3.5" />
        </button>
      </div>

      {ordered.length === 0 ? (
        <div
          className="px-4 py-2 text-xs text-sidebar-foreground/50 italic"
          data-testid="sidebar-workspace-nav-empty"
        >
          No workspaces
        </div>
      ) : (
        ordered.map((ws) => (
          <WorkspaceTreeNode
            key={ws.id}
            workspace={ws}
            focused={ws.id === focusedId}
            onSelect={() => handleSelect(ws)}
          />
        ))
      )}

      <button
        type="button"
        onClick={handleAdd}
        data-testid="sidebar-workspace-new"
        className="flex items-center gap-2 mx-2 my-px px-3 py-1.5 rounded-sm text-sm text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-foreground/5 transition-colors"
      >
        <Plus className="size-[18px] shrink-0" />
        <span className="flex-1 truncate text-left">New workspace</span>
      </button>
    </div>
  );
}

// A workspace disclosure node: the header row (chevron + avatar + name) and its
// nested contents. The contents stay mounted whether or not the node is focused
// so that BOTH expand and collapse animate — the wrapper transitions its height
// (grid-rows 0fr↔1fr, the pure-CSS route to/from `auto`) plus a fade. On a
// switch the leaving node collapses while the entering node expands, in sync.
function WorkspaceTreeNode({
  workspace,
  focused,
  onSelect,
}: {
  workspace: WorkspaceInfo;
  focused: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className="flex flex-col"
      data-testid="sidebar-workspace-node"
      data-workspace-id={workspace.id}
    >
      <WorkspaceHeaderRow workspace={workspace} focused={focused} onSelect={onSelect} />
      <div
        // grid-rows 0fr→1fr animates height to/from content size; the inner
        // `overflow-hidden` + `min-h-0` clips during the transition. Honors
        // reduced-motion.
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          focused ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
        data-testid="sidebar-workspace-contents"
        data-workspace-id={workspace.id}
        data-expanded={focused ? "true" : "false"}
        // Collapsed contents are inert — removed from tab order + the
        // accessibility tree, so only the focused node's views are reachable.
        inert={focused ? undefined : true}
      >
        <div className="min-h-0 overflow-hidden">
          <WorkspaceContents workspace={workspace} focused={focused} />
        </div>
      </div>
    </div>
  );
}

// The clickable workspace header row: a disclosure chevron, the avatar (or a
// Home glyph for Personal), and the name. The whole row focuses the workspace —
// the chevron is a state indicator, not a separate toggle, since exactly one
// workspace (the focused one) is ever expanded.
function WorkspaceHeaderRow({
  workspace,
  focused,
  onSelect,
}: {
  workspace: WorkspaceInfo;
  focused: boolean;
  onSelect: () => void;
}) {
  const isPersonal = workspace.isPersonal === true;
  const label = isPersonal ? "Home · Personal" : workspace.name;
  return (
    <button
      type="button"
      onClick={onSelect}
      // The focused workspace is a location indicator, not the active route —
      // the nested NavLink carries aria-current="page" for the actual view.
      aria-current={focused ? "location" : undefined}
      aria-expanded={focused}
      title={label}
      data-testid="sidebar-workspace-header"
      data-workspace-id={workspace.id}
      data-focused={focused ? "true" : "false"}
      data-is-personal={isPersonal ? "true" : "false"}
      className={cn(
        "group flex items-center gap-1.5 text-sm transition-colors text-left rounded-sm mx-2 my-px px-1.5 py-1.5",
        focused
          ? "bg-sidebar-foreground/10 font-medium text-sidebar-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-foreground/5",
      )}
    >
      <ChevronRight
        aria-hidden="true"
        className={cn(
          "size-3.5 shrink-0 text-sidebar-foreground/40 transition-transform",
          focused && "rotate-90",
        )}
      />
      <WorkspaceGlyph workspace={workspace} personal={isPersonal} />
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}

// The avatar slot. Personal shows a Home glyph (it's home, not a named team);
// every other workspace shows its deterministic letter+color avatar.
function WorkspaceGlyph({ workspace, personal }: { workspace: WorkspaceInfo; personal: boolean }) {
  if (personal) {
    return (
      <span
        aria-hidden="true"
        className="size-[18px] shrink-0 flex items-center justify-center rounded-sm bg-sidebar-foreground/10 text-sidebar-foreground/80"
      >
        <Home className="size-3" />
      </span>
    );
  }
  const avatar = getWorkspaceAvatar(workspace);
  return (
    <span
      aria-hidden="true"
      data-testid="workspace-avatar"
      className="size-[18px] shrink-0 flex items-center justify-center rounded-sm text-white text-3xs font-semibold"
      style={{ backgroundColor: avatar.color }}
    >
      {avatar.letter}
    </span>
  );
}

// Avatar-only button for the collapsed (icon-only) sidebar.
function WorkspaceAvatarButton({
  workspace,
  focused,
  onSelect,
}: {
  workspace: WorkspaceInfo;
  focused: boolean;
  onSelect: () => void;
}) {
  const isPersonal = workspace.isPersonal === true;
  const label = isPersonal ? "Home · Personal" : workspace.name;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={label}
      aria-current={focused ? "location" : undefined}
      title={label}
      data-testid="sidebar-workspace-header"
      data-workspace-id={workspace.id}
      data-focused={focused ? "true" : "false"}
      data-is-personal={isPersonal ? "true" : "false"}
      className={cn(
        "flex items-center justify-center p-1.5 mx-2 my-px rounded-sm transition-colors",
        focused ? "bg-sidebar-foreground/10" : "hover:bg-sidebar-foreground/5",
      )}
    >
      <WorkspaceGlyph workspace={workspace} personal={isPersonal} />
    </button>
  );
}

// A workspace's subtree: identity views, then APPS, then CONNECTORS. Indented
// under the header with a connecting rule (Notion/Linear tree look). Rendered
// for every node (so collapse animates), but only the focused node shows its
// apps + a live connector count — a collapsed node is mid-transition and hidden.
function WorkspaceContents({ workspace, focused }: { workspace: WorkspaceInfo; focused: boolean }) {
  const shell = useShellContext();
  const { iconFor, connectorCount } = useWorkspaceAppIcons();
  const slug = toSlug(workspace.id);

  // Identity views (Conversations / Automations / Files): the bare-"sidebar"
  // placements that are identity-owned, priority-ordered.
  const identityViews = useMemo(() => {
    const placements = shell?.forSlot("sidebar") ?? [];
    return placements
      .filter((p) => p.slot === "sidebar" && isIdentityApp(p.serverName))
      .sort((a, b) => a.priority - b.priority);
  }, [shell]);

  // The workspace's own apps (People, Tasks, …). Gate on the shell's
  // placements actually reflecting THIS workspace — the shell lags a switch,
  // so without the gate a switch would briefly paint the previous workspace's
  // apps (mirrors the overview grid's readiness check).
  const ready = shell != null && shell.shellWorkspaceId === workspace.id;
  const apps = useMemo(
    () => (ready && shell ? workspaceApps(shell.forSlot("sidebar")) : []),
    [ready, shell],
  );
  const shownApps = apps.slice(0, MAX_INLINE_APPS);
  const hasAppOverflow = apps.length > shownApps.length;

  return (
    <div className="ml-[18px] mr-2 mb-1 mt-px flex flex-col border-l border-sidebar-foreground/10 pl-2">
      {identityViews.map((p) => (
        <NestedNavLink
          key={p.resourceUri}
          to={identityAppRoute(p.serverName, slug)}
          icon={p.icon}
          label={p.label ?? p.serverName}
          end
        />
      ))}

      {shownApps.length > 0 && (
        <>
          <SubLabel>Apps</SubLabel>
          {shownApps.map((p) => (
            <NestedAppLink
              key={p.resourceUri}
              to={`/w/${slug}/app/${p.route}`}
              label={p.label ?? p.route ?? "App"}
              serverName={p.serverName}
              iconUrl={iconFor(p.serverName)}
            />
          ))}
          {hasAppOverflow && (
            <Link
              to={`/w/${slug}/`}
              data-testid="sidebar-workspace-view-all"
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
            >
              <ArrowRight className="size-3 shrink-0" />
              <span className="truncate">View all {apps.length} apps</span>
            </Link>
          )}
        </>
      )}

      <SubLabel>Connectors</SubLabel>
      {/* Connectors — the workspace's installed tools. Routes to its settings
          tab; sub-routes (browse, detail) keep it lit, so not `end`. The count
          is the focused workspace's installed connectors (the provider holds
          one workspace's set); a collapsed node omits it to avoid showing the
          focused workspace's number on a different row mid-collapse. */}
      <NestedNavLink
        to={`/w/${slug}/settings/connectors`}
        icon="plug"
        label="Connectors"
        count={focused ? connectorCount : undefined}
      />
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pt-2 pb-0.5 text-2xs font-bold tracking-[0.08em] text-sidebar-foreground/40 uppercase">
      {children}
    </div>
  );
}

// A nested workspace view with a lucide icon — identity views + Connectors.
// Optional trailing count badge (right-aligned, muted).
function NestedNavLink({
  to,
  icon,
  label,
  end,
  count,
}: {
  to: string;
  icon?: string;
  label: string;
  end?: boolean;
  count?: number;
}) {
  const Icon = resolveIcon(icon);
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
      data-testid="sidebar-workspace-view"
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 text-sm transition-colors rounded-sm px-2 py-1",
          isActive
            ? "bg-sidebar-foreground/10 text-sidebar-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground",
        )
      }
    >
      <Icon className="size-[18px] shrink-0" />
      <span className="flex-1 truncate">{label}</span>
      <CountBadge count={count} />
    </NavLink>
  );
}

// A nested workspace app with a brand icon (letter-avatar fallback). Exact-match
// active: app routes are leaf paths, so the URL maps to one placement (a
// `startsWith` would mis-light `crm` when viewing a sibling `crm-archive`).
function NestedAppLink({
  to,
  label,
  serverName,
  iconUrl,
}: {
  to: string;
  label: string;
  serverName: string;
  iconUrl?: string;
}) {
  const location = useLocation();
  const isActive = location.pathname === to;
  return (
    <Link
      to={to}
      title={label}
      data-testid="sidebar-workspace-app"
      data-app-route={serverName}
      data-is-active={isActive ? "true" : "false"}
      className={cn(
        "flex items-center gap-2 text-sm transition-colors rounded-sm px-2 py-1",
        isActive
          ? "bg-sidebar-foreground/10 text-sidebar-foreground"
          : "text-sidebar-foreground/80 hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground",
      )}
    >
      <ConnectorIcon name={label} iconUrl={iconUrl} className="size-[18px] rounded-xs text-3xs" />
      <span className="flex-1 truncate">{label}</span>
    </Link>
  );
}

// A right-aligned muted count. Renders nothing for undefined / zero — an empty
// list shows no badge rather than a "0".
function CountBadge({ count }: { count?: number }) {
  if (count === undefined || count <= 0) return null;
  return (
    <span
      data-testid="sidebar-workspace-count"
      className="shrink-0 text-2xs tabular-nums text-sidebar-foreground/40"
    >
      {count}
    </span>
  );
}
