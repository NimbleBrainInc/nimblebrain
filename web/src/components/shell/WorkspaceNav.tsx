// ---------------------------------------------------------------------------
// WorkspaceNav — the focused workspace's views (the left-nav body).
//
// One workspace at a time, flat: the runtime walls every session to exactly
// one workspace, so the nav shows only that one's views, and the way to see
// another workspace's is to switch to it (WorkspaceSwitcher, above this).
//
// Order: Overview, the identity views (Conversations / Automations / Files),
// then APPS (People, Tasks, … — capped with a View-all overflow). Each routes
// into `/w/<slug>/…`. An app that places several views is one entry; while it
// is open its views list beneath it. The inbox is not here: it is the top
// bar's bell (InboxToggle).
//
// APPS holds everything installed. A connector with a view gets a row; the
// ones without (tools the agent uses, with nothing to open) share one row,
// their icons and a count, that opens the installed list where each is
// configured. So every install shows up, and screen-less ones cost one row.
// The header's "+" opens the catalog. The identity views' TOOLS still
// dispatch bare through the identity door (see lib/identity-apps); the slug
// here is the focused workspace = view scope, not a tool namespace.
//
// Collapsed (icon rail) renders the same destinations as icon buttons, each
// named by a tooltip, with the "+" last.
// ---------------------------------------------------------------------------

import { ArrowRight, LayoutGrid, Plus } from "lucide-react";
import { useMemo } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import type { InstalledConnector } from "../../api/client";
import { useShellContext } from "../../context/ShellContext";
import { useWorkspaceAppIcons } from "../../context/WorkspaceAppIconsContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { useCanWriteActiveWorkspace } from "../../hooks/useScopedRole";
import { resolveIcon } from "../../lib/icons";
import { identityAppRoute, isIdentityApp } from "../../lib/identity-apps";
import { cn } from "../../lib/utils";
import {
  appsByConnector,
  MAX_INLINE_APPS,
  type WorkspaceApp,
  workspaceApps,
} from "../../lib/workspace-apps";
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
  const { iconFor, connectors } = useWorkspaceAppIcons();
  // Installing writes the workspace, so only a member who may write it gets the "+".
  const canInstall = useCanWriteActiveWorkspace();
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
    () => (ready && shell ? appsByConnector(workspaceApps(shell.forSlot("sidebar"))) : []),
    [ready, shell],
  );
  const shownApps = collapsed ? apps : apps.slice(0, MAX_INLINE_APPS);
  const hasAppOverflow = apps.length > shownApps.length;

  // Installed connectors with no view of their own. Anything installed that is
  // not an app above lands here, so each install appears exactly once. Read
  // only once the list names this workspace (it lags a switch, like the shell).
  const toolsOnly = useMemo(() => {
    if (!ready || connectors?.workspaceId !== workspace.id) return [];
    const withViews = new Set(apps.map((app) => app.serverName));
    return connectors.installed.filter(
      (c) => !withViews.has(c.serverName) && !isIdentityApp(c.serverName),
    );
  }, [ready, connectors, workspace.id, apps]);
  const hasSection = shownApps.length > 0 || toolsOnly.length > 0 || canInstall;
  // A connector's display name (its catalog title), from the same installed list.
  const nameFor = (serverName: string) =>
    connectors?.workspaceId === workspace.id
      ? connectors.installed.find((c) => c.serverName === serverName)?.displayName
      : undefined;

  return (
    <div
      className={cn("group/nav flex flex-col gap-px", collapsed ? "items-center px-3" : "px-2")}
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

      {hasSection &&
        (collapsed ? (
          <div aria-hidden="true" className="my-1.5 h-px w-6 bg-sidebar-border" />
        ) : (
          <div className="flex items-center justify-between pt-3 pr-1 pb-1 pl-2">
            <span className="text-2xs font-bold tracking-[0.08em] uppercase">Apps</span>
            {canInstall && <AddLink slug={slug} collapsed={false} />}
          </div>
        ))}
      {shownApps.map((app) => (
        <AppEntry
          key={app.serverName}
          app={app}
          slug={slug}
          name={nameFor(app.serverName)}
          iconUrl={iconFor(app.serverName)}
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

      {toolsOnly.length > 0 && (
        <ToolsOnlyLink
          to={`/w/${slug}/settings/connectors`}
          connectors={toolsOnly}
          afterApps={shownApps.length > 0}
          collapsed={collapsed}
        />
      )}
      {collapsed && canInstall && <AddLink slug={slug} collapsed />}
    </div>
  );
}

// The "+" that opens the connector catalog. Beside the APPS header it shows
// while the pointer is over the nav or it has keyboard focus; `hover:` applies
// only on devices that hover, so a touch screen shows it at rest. In the rail
// it is an icon button like the rows above it.
function AddLink({ slug, collapsed }: { slug: string; collapsed: boolean }) {
  const label = "Add apps and tools";
  return (
    <Tooltip label={label} side="right">
      <Link
        to={`/w/${slug}/settings/connectors/browse`}
        aria-label={label}
        data-testid="sidebar-add-connector"
        className={cn(
          "flex items-center justify-center rounded-sm transition-colors hover:bg-sidebar-foreground/10 hover:text-foreground",
          collapsed
            ? "size-9"
            : "size-5 transition-opacity [@media(hover:hover)]:opacity-0 group-hover/nav:opacity-100 focus-visible:opacity-100",
        )}
      >
        <Plus className={collapsed ? "size-4" : "size-3.5"} />
      </Link>
    </Tooltip>
  );
}

// The installed connectors with no view, as one row: up to three of their
// icons, overlapped, and a count (or the name, when there is one). Lit on the
// installed list and its sub-pages, so not `end`.
const STACKED_ICONS = 3;

function ToolsOnlyLink({
  to,
  connectors,
  afterApps,
  collapsed,
}: {
  to: string;
  connectors: InstalledConnector[];
  afterApps: boolean;
  collapsed: boolean;
}) {
  const names = connectors.map((c) => c.displayName).join(", ");
  const [only] = connectors;
  const label =
    connectors.length === 1 && only
      ? only.displayName
      : `${connectors.length} ${afterApps ? "more " : ""}connected`;
  const shown = connectors.slice(0, collapsed ? 1 : STACKED_ICONS);
  const link = (
    <NavLink
      to={to}
      aria-label={collapsed ? `${label}: ${names}` : undefined}
      title={collapsed ? undefined : names}
      data-testid="sidebar-workspace-tools"
      className={({ isActive }) => rowClass(isActive, collapsed)}
    >
      <span className="flex shrink-0 -space-x-1">
        {shown.map((c) => (
          <ConnectorIcon
            key={c.serverName}
            name={c.displayName}
            iconUrl={c.iconUrl}
            className="size-4 rounded-xs text-3xs ring-2 ring-sidebar"
          />
        ))}
      </span>
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip label={names} side="right">
      {link}
    </Tooltip>
  ) : (
    link
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

// A workspace view with a lucide icon.
function ViewLink({
  to,
  icon: Icon,
  label,
  end,
  collapsed,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  end?: boolean;
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
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip label={label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

// One app. With a single view it is that view's link. With several it is a row
// that opens the first view, and while any of its views is on screen they list
// beneath it: the views are the app's own navigation, so they appear when the
// app is in use and stay out of the nav otherwise. The open view carries the
// highlight and `aria-current`; the app row only reads as open.
function AppEntry({
  app,
  slug,
  name,
  iconUrl,
  collapsed,
}: {
  app: WorkspaceApp;
  slug: string;
  /** The connector's display name; until the installed list lands, the first view's label. */
  name?: string;
  iconUrl?: string;
  collapsed: boolean;
}) {
  const { pathname } = useLocation();
  const [first] = app.views;
  if (!first) return null;
  const to = (view: WorkspaceApp["views"][number]) => `/w/${slug}/app/${view.route}`;
  const viewLabel = (view: WorkspaceApp["views"][number]) => view.label ?? view.route ?? "App";
  if (app.views.length === 1) {
    return (
      <AppLink
        to={to(first)}
        label={viewLabel(first)}
        iconUrl={iconUrl}
        serverName={app.serverName}
        collapsed={collapsed}
      />
    );
  }
  const open = app.views.some((view) => pathname === to(view));
  return (
    <>
      <AppLink
        to={to(first)}
        label={name ?? viewLabel(first)}
        iconUrl={iconUrl}
        serverName={app.serverName}
        collapsed={collapsed}
        open={open}
      />
      {open && !collapsed && (
        <div className="flex flex-col gap-px" data-testid="sidebar-workspace-app-views">
          {app.views.map((view) => (
            <NavLink
              key={view.resourceUri}
              to={to(view)}
              end
              data-testid="sidebar-workspace-app-view"
              className={({ isActive }) => cn(rowClass(isActive, false), "pl-[2.125rem]")}
            >
              <span className="flex-1 truncate">{viewLabel(view)}</span>
            </NavLink>
          ))}
        </div>
      )}
    </>
  );
}

// A workspace app with a brand icon (letter-avatar fallback). Exact-match
// active: app routes are leaf paths, so the URL maps to one placement (a
// `startsWith` would mis-light `crm` when viewing a sibling `crm-archive`).
// `open` is set by an app whose views list beneath it: the row then reads as
// open rather than current, because the current page is one of its views.
function AppLink({
  to,
  label,
  serverName,
  iconUrl,
  collapsed,
  open,
}: {
  to: string;
  label: string;
  serverName: string;
  iconUrl?: string;
  collapsed: boolean;
  open?: boolean;
}) {
  const exact = useLocation().pathname === to;
  // Collapsed, the views are not listed, so the app's icon is what marks the page.
  const isActive = open === undefined ? exact : open && collapsed;
  const link = (
    <Link
      to={to}
      aria-label={collapsed ? label : undefined}
      data-testid="sidebar-workspace-app"
      data-app-route={serverName}
      data-is-active={isActive ? "true" : "false"}
      aria-current={isActive ? "page" : undefined}
      className={cn(rowClass(isActive, collapsed), open && "font-medium text-foreground")}
    >
      <ConnectorIcon name={label} iconUrl={iconUrl} className="size-4 rounded-xs text-3xs" />
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
    </Link>
  );
  return collapsed ? (
    <Tooltip label={label} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}
