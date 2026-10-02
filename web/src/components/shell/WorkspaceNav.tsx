// ---------------------------------------------------------------------------
// WorkspaceNav — the focused workspace's views (the left-nav body).
//
// One workspace at a time, flat: the runtime walls every session to exactly
// one workspace, so the nav shows only that one's views, and the way to see
// another workspace's is to switch to it (WorkspaceSwitcher, above this).
//
// Order: Overview, the identity views (Conversations / Automations / Files),
// Inbox, then APPS (People, Tasks, … — capped with a View-all overflow), then
// Connectors. Each routes into `/w/<slug>/…`. The identity views' TOOLS still
// dispatch bare through the identity door (see lib/identity-apps); the slug
// here is the focused workspace = view scope, not a tool namespace.
//
// Collapsed (icon rail) renders the same destinations as icon buttons, each
// named by a tooltip.
// ---------------------------------------------------------------------------

import { ArrowRight, LayoutGrid } from "lucide-react";
import { useMemo } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useNotifications } from "../../context/NotificationsContext";
import { useShellContext } from "../../context/ShellContext";
import { useWorkspaceAppIcons } from "../../context/WorkspaceAppIconsContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { resolveIcon } from "../../lib/icons";
import { identityAppRoute, isIdentityApp } from "../../lib/identity-apps";
import { cn } from "../../lib/utils";
import { MAX_INLINE_APPS, workspaceApps } from "../../lib/workspace-apps";
import { toSlug } from "../../lib/workspace-slug";
import { ConnectorIcon } from "../connectors/ConnectorIcon";
import { Tooltip } from "../ui/tooltip";

interface WorkspaceNavProps {
  /** Icon rail: every destination as an icon button with a tooltip. */
  collapsed?: boolean;
}

export function WorkspaceNav({ collapsed = false }: WorkspaceNavProps) {
  const { activeWorkspace } = useWorkspaceContext();
  if (!activeWorkspace) return null;
  return <WorkspaceViews workspace={activeWorkspace} collapsed={collapsed} />;
}

function WorkspaceViews({
  workspace,
  collapsed,
}: {
  workspace: WorkspaceInfo;
  collapsed: boolean;
}) {
  const shell = useShellContext();
  const { iconFor, connectorCount } = useWorkspaceAppIcons();
  const { unread } = useNotifications();
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
  const shownApps = collapsed ? apps : apps.slice(0, MAX_INLINE_APPS);
  const hasAppOverflow = apps.length > shownApps.length;

  return (
    <div
      className={cn("flex flex-col gap-px", collapsed ? "items-center px-3" : "px-2")}
      data-testid="sidebar-workspace-nav"
      data-workspace-id={workspace.id}
      data-collapsed={collapsed ? "true" : "false"}
    >
      <ViewLink to={`/w/${slug}/`} icon={LayoutGrid} label="Overview" end collapsed={collapsed} />
      {identityViews.map((p) => (
        <ViewLink
          key={p.resourceUri}
          to={identityAppRoute(p.serverName, slug)}
          icon={resolveIcon(p.icon)}
          label={p.label ?? p.serverName}
          end
          collapsed={collapsed}
        />
      ))}

      {/* The inbox sits with the identity views, not under Apps: it belongs to
          the workspace rather than to any connector. */}
      <ViewLink
        to={`/w/${slug}/notifications`}
        icon={resolveIcon("bell")}
        label="Inbox"
        count={unread}
        collapsed={collapsed}
      />

      {shownApps.length > 0 &&
        (collapsed ? (
          <div aria-hidden="true" className="my-1.5 h-px w-6 bg-sidebar-border" />
        ) : (
          <div className="px-2 pt-3 pb-1 text-2xs font-bold tracking-[0.08em] uppercase">Apps</div>
        ))}
      {shownApps.map((p) => (
        <AppLink
          key={p.resourceUri}
          to={`/w/${slug}/app/${p.route}`}
          label={p.label ?? p.route ?? "App"}
          iconUrl={iconFor(p.serverName)}
          serverName={p.serverName}
          collapsed={collapsed}
        />
      ))}
      {hasAppOverflow && (
        <Link
          to={`/w/${slug}/`}
          data-testid="sidebar-workspace-view-all"
          className="flex items-center gap-2.5 rounded-sm px-2 py-1 text-xs transition-colors hover:bg-sidebar-foreground/5"
        >
          <ArrowRight className="size-3 shrink-0" />
          <span className="truncate">View all {apps.length} apps</span>
        </Link>
      )}

      {/* Connectors — the workspace's installed tools. Routes to its settings
          tab; sub-routes (browse, detail) keep it lit, so not `end`. */}
      {!collapsed && <div aria-hidden="true" className="h-2" />}
      <ViewLink
        to={`/w/${slug}/settings/connectors`}
        icon={resolveIcon("plug")}
        label="Connectors"
        count={connectorCount}
        collapsed={collapsed}
      />
    </div>
  );
}

const rowClass = (isActive: boolean, collapsed: boolean) =>
  cn(
    "flex items-center rounded-sm text-sm transition-colors",
    collapsed ? "size-9 justify-center" : "gap-2.5 px-2 min-h-8",
    isActive
      ? "bg-sidebar-foreground/10 font-medium text-foreground"
      : "font-normal hover:bg-sidebar-foreground/5 hover:text-foreground",
  );

// A workspace view with a lucide icon, and an optional trailing count.
function ViewLink({
  to,
  icon: Icon,
  label,
  end,
  count,
  collapsed,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  end?: boolean;
  count?: number;
  collapsed: boolean;
}) {
  const link = (
    <NavLink
      to={to}
      end={end}
      aria-label={collapsed ? label : undefined}
      data-testid="sidebar-workspace-view"
      className={({ isActive }) => rowClass(isActive, collapsed)}
    >
      <Icon className="size-4 shrink-0" />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{label}</span>
          <CountBadge count={count} />
        </>
      )}
    </NavLink>
  );
  return collapsed ? <Tooltip label={label}>{link}</Tooltip> : link;
}

// A workspace app with a brand icon (letter-avatar fallback). Exact-match
// active: app routes are leaf paths, so the URL maps to one placement (a
// `startsWith` would mis-light `crm` when viewing a sibling `crm-archive`).
function AppLink({
  to,
  label,
  serverName,
  iconUrl,
  collapsed,
}: {
  to: string;
  label: string;
  serverName: string;
  iconUrl?: string;
  collapsed: boolean;
}) {
  const isActive = useLocation().pathname === to;
  const link = (
    <Link
      to={to}
      aria-label={collapsed ? label : undefined}
      data-testid="sidebar-workspace-app"
      data-app-route={serverName}
      data-is-active={isActive ? "true" : "false"}
      aria-current={isActive ? "page" : undefined}
      className={rowClass(isActive, collapsed)}
    >
      <ConnectorIcon name={label} iconUrl={iconUrl} className="size-4 rounded-xs text-3xs" />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
    </Link>
  );
  return collapsed ? <Tooltip label={label}>{link}</Tooltip> : link;
}

// A right-aligned muted count. Renders nothing for undefined / zero — an empty
// list shows no badge rather than a "0".
function CountBadge({ count }: { count?: number }) {
  if (count === undefined || count <= 0) return null;
  return (
    <span data-testid="sidebar-workspace-count" className="shrink-0 text-2xs tabular-nums">
      {count}
    </span>
  );
}
