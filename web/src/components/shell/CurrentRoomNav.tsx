// ---------------------------------------------------------------------------
// CurrentRoomNav — the room you're in, as the parent of its contents.
//
// Room-centric IA: you are always *in* a room (Home = Personal), and the room
// scopes everything beneath it. The focused room is promoted to this dedicated
// section — its Conversations / Automations / Files / Connectors, then its own
// apps (People, Tasks, …) — while the WORKSPACES list below holds the OTHER
// rooms. When you're focused on a shared room, a compact Personal row sits
// above it as the way home.
//
// This replaces the previous "Conversations / Automations / Files are global
// top-level nav, workspaces are a sibling category" arrangement: those views
// are room-scoped now (the runtime walls each session to one workspace), so
// the UI nests them under the room rather than floating them above it.
// ---------------------------------------------------------------------------

import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useShellContext } from "../../context/ShellContext";
import { useWorkspaceAppIcons } from "../../context/WorkspaceAppIconsContext";
import { useWorkspaceContext, type WorkspaceInfo } from "../../context/WorkspaceContext";
import { resolveIcon } from "../../lib/icons";
import { identityAppRoute, isIdentityApp } from "../../lib/identity-apps";
import { cn } from "../../lib/utils";
import { MAX_INLINE_APPS, workspaceApps } from "../../lib/workspace-apps";
import { getWorkspaceAvatar } from "../../lib/workspace-avatar";
import { toSlug } from "../../lib/workspace-slug";
import { ConnectorIcon } from "../connectors/ConnectorIcon";

export function CurrentRoomNav({ collapsed = false }: { collapsed?: boolean }) {
  const wsCtx = useWorkspaceContext();
  const shell = useShellContext();
  const { iconFor } = useWorkspaceAppIcons();
  const navigate = useNavigate();

  const focused = wsCtx.activeWorkspace;
  const personal = useMemo(
    () => wsCtx.workspaces.find((w) => w.isPersonal) ?? null,
    [wsCtx.workspaces],
  );

  // Identity apps (Conversations / Automations / Files): the bare-"sidebar"
  // placements that are identity-owned. Home is intentionally dropped — the
  // Personal room IS home, so a separate Home item would be redundant.
  const identityApps = useMemo(() => {
    const placements = shell?.forSlot("sidebar") ?? [];
    return placements
      .filter((p) => p.slot === "sidebar" && isIdentityApp(p.serverName))
      .sort((a, b) => a.priority - b.priority);
  }, [shell]);

  // The focused room's own apps (People, Tasks, …). Only once the shell's
  // placements reflect THIS room — it lags a switch, so without the gate a
  // switch would briefly paint the previous room's apps (mirrors the overview
  // grid's readiness check).
  const ready = shell != null && focused != null && shell.shellWorkspaceId === focused.id;
  const apps = useMemo(
    () => (ready && shell ? workspaceApps(shell.forSlot("sidebar")) : []),
    [ready, shell],
  );

  if (wsCtx.loading || !focused) return null;

  const isPersonalFocused = focused.isPersonal === true;
  const slug = toSlug(focused.id);

  // Cap the app quick-list; the overflow link routes to the room's overview
  // grid (the full set) — same top-N contract as the previous inline list.
  const shownApps = apps.slice(0, MAX_INLINE_APPS);
  const hasAppOverflow = apps.length > shownApps.length;

  return (
    <div className="flex flex-col" data-testid="sidebar-current-room" data-room-id={focused.id}>
      {/* The way home — shown only when focused on a shared room. */}
      {!isPersonalFocused && personal && (
        <RoomHeaderRow
          workspace={personal}
          label="Personal"
          collapsed={collapsed}
          focused={false}
          onSelect={() => {
            if (wsCtx.activeWorkspace?.id !== personal.id) wsCtx.setActiveWorkspace(personal);
            navigate("/");
          }}
        />
      )}

      {/* The room you're in. */}
      <RoomHeaderRow
        workspace={focused}
        label={isPersonalFocused ? "Personal" : focused.name}
        collapsed={collapsed}
        focused
        onSelect={() => navigate(isPersonalFocused ? "/" : `/w/${slug}/`)}
      />

      {/* Its contents, nested under the room. Hidden in collapsed (icon-only)
          mode — nested icons would float without their room-header context. */}
      {!collapsed && (
        <div
          className="ml-4 mr-2 mb-1 mt-px flex flex-col border-l border-sidebar-foreground/10 pl-1"
          data-testid="sidebar-current-room-contents"
        >
          {identityApps.map((p) => (
            <NestedNavLink
              key={p.resourceUri}
              to={identityAppRoute(p.serverName)}
              icon={p.icon}
              label={p.label ?? p.serverName}
              end
            />
          ))}
          {/* Connectors — the room's installed tools. Routes to its settings
              tab; sub-routes (browse, detail) keep it lit, so not `end`. */}
          <NestedNavLink to={`/w/${slug}/settings/connectors`} icon="plug" label="Connectors" />
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
              data-testid="sidebar-room-view-all"
              className="flex items-center gap-1.5 px-2 py-1 text-xs text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
            >
              <ArrowRight className="size-3 shrink-0" />
              <span className="truncate">View all {apps.length} apps</span>
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

// The focused room (and the Personal way-home row) — avatar + name. `focused`
// styles the room you're in more prominently than the muted home row.
function RoomHeaderRow({
  workspace,
  label,
  collapsed,
  focused,
  onSelect,
}: {
  workspace: WorkspaceInfo;
  label: string;
  collapsed: boolean;
  focused: boolean;
  onSelect: () => void;
}) {
  const avatar = getWorkspaceAvatar(workspace);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={collapsed ? label : undefined}
      aria-current={focused ? "true" : undefined}
      title={label}
      data-testid="sidebar-room-header"
      data-room-id={workspace.id}
      data-focused={focused ? "true" : "false"}
      className={cn(
        "flex items-center text-sm transition-colors text-left rounded-sm mx-2 my-px",
        collapsed ? "justify-center p-1.5" : "gap-2 px-3 py-1.5",
        focused
          ? "font-medium text-sidebar-foreground"
          : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-foreground/5",
      )}
    >
      <span
        aria-hidden="true"
        className="size-[18px] shrink-0 flex items-center justify-center rounded-sm text-white text-3xs font-semibold"
        style={{ backgroundColor: avatar.color }}
      >
        {avatar.letter}
      </span>
      {!collapsed && <span className="flex-1 truncate">{label}</span>}
    </button>
  );
}

// A nested room view with a lucide icon — identity apps + Connectors.
function NestedNavLink({
  to,
  icon,
  label,
  end,
}: {
  to: string;
  icon?: string;
  label: string;
  end?: boolean;
}) {
  const Icon = resolveIcon(icon);
  return (
    <NavLink
      to={to}
      end={end}
      title={label}
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
      data-testid="sidebar-room-app"
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
