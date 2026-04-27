import { ChevronLeft, ChevronRight } from "lucide-react";
import { memo } from "react";
import { NavLink } from "react-router-dom";
import { useSidebar } from "../context/SidebarContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { resolveIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { toSlug } from "../lib/workspace-slug";
import type { PlacementEntry } from "../types";
import { Logo } from "./Logo";
import { MobileSidebarDrawer } from "./MobileSidebarDrawer";
import { SidebarToggle } from "./SidebarToggle";
import { UserMenu } from "./UserMenu";
import { WorkspaceSelector } from "./WorkspaceSelector";

/**
 * Priority threshold for ungrouped (core) sidebar items.
 * Items in the bare "sidebar" slot with priority < 10 render at the top
 * without a group label. Everything else groups by sub-slot.
 *
 * Convention:
 *   priority 0-9  → ungrouped core nav (Home, Conversations)
 *   priority 10+  → grouped under their sub-slot label
 *   sidebar.apps  → "Apps" group
 *   sidebar.fun   → "Fun" group
 *   sidebar.bottom → pinned to bottom zone
 */
const UNGROUPED_PRIORITY_THRESHOLD = 10;

interface ShellLayoutProps {
  forSlot: (slot: string) => PlacementEntry[];
  onLogout: () => void;
  children: React.ReactNode;
}

/**
 * Shell layout — renders navigation chrome from placement data.
 *
 * Sidebar has three responsive states:
 * - Expanded (>=1024px): full sidebar with labels
 * - Collapsed (768-1023px): icon-only sidebar
 * - Hidden (<768px): mobile drawer
 *
 * Sidebar has three zones:
 * - Ungrouped: core nav items (sidebar slot, priority < 10) — no label
 * - Grouped: sub-slot groups (sidebar.apps, sidebar.fun, etc.) — with labels
 * - Bottom: pinned items (sidebar.bottom) — separated by border
 */
export const ShellLayout = memo(function ShellLayout({
  forSlot,
  onLogout,
  children,
}: ShellLayoutProps) {
  const { state: sidebarState, setDrawerOpen } = useSidebar();
  const isCollapsed = sidebarState === "collapsed";
  const isHidden = sidebarState === "hidden";
  const wsCtx = useWorkspaceContext();
  const wsSlug = wsCtx.activeWorkspace ? toSlug(wsCtx.activeWorkspace.id) : undefined;

  // All sidebar items except bottom-pinned
  const sidebarAll = forSlot("sidebar").filter((p) => !p.slot.startsWith("sidebar.bottom"));

  // Ungrouped core items: bare "sidebar" slot with priority < threshold
  const ungrouped = sidebarAll.filter(
    (p) => p.slot === "sidebar" && p.priority < UNGROUPED_PRIORITY_THRESHOLD,
  );

  // Grouped items: everything else (sub-slots + bare sidebar with priority >= threshold)
  const grouped = sidebarAll.filter(
    (p) => p.slot !== "sidebar" || p.priority >= UNGROUPED_PRIORITY_THRESHOLD,
  );
  const groups = groupBySubSlot(grouped, "sidebar");

  // Sidebar bottom items: pinned to bottom, excluding settings (now in workspace dropdown)
  const sidebarBottom = forSlot("sidebar.bottom").filter((p) => p.route !== "settings");

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Desktop / tablet sidebar */}
      {!isHidden && (
        <nav
          className={cn(
            // `relative` anchors the half-overflow edge toggle below.
            "relative shrink-0 h-dvh flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border transition-[width] duration-200",
            isCollapsed ? "w-16" : "w-60",
          )}
        >
          {/* Workspace identity */}
          <div className={`${isCollapsed ? "px-0 pt-3 pb-1" : "px-1 pt-3 pb-1"} shrink-0`}>
            <WorkspaceSelector collapsed={isCollapsed} />
          </div>

          {/* Top zone — scrollable; key triggers fade-in on workspace switch */}
          <div key={wsSlug} className="flex-1 overflow-y-auto py-1 sidebar-scroll sidebar-nav-fade">
            {/* Ungrouped core nav — no label */}
            {ungrouped.map((p) => (
              <NavItem
                key={p.resourceUri}
                to={resolveRoute(p, wsSlug)}
                icon={p.icon}
                label={p.label ?? "Item"}
                collapsed={isCollapsed}
                end={p.route === "/"}
              />
            ))}

            {/* Grouped sidebar placements — with labels */}
            {Object.entries(groups).map(([group, items]) => (
              <SidebarGroup
                key={group}
                label={group}
                items={items}
                collapsed={isCollapsed}
                wsSlug={wsSlug}
              />
            ))}
          </div>

          {/* Bottom zone — identity only. The collapse toggle is rendered
              as a half-overflow edge button (below) rather than competing
              for space here; this keeps the bottom strip as a coherent
              "this is YOU" anchor without a category-mismatched utility
              control attached. */}
          <div className="shrink-0 border-t border-sidebar-border py-2">
            <UserMenu collapsed={isCollapsed} onLogout={onLogout} />
          </div>

          {/*
            Edge collapse toggle — anchored to the sidebar's right border,
            half-overflowing. Always visible (rather than hover-only) so
            it's reachable on touch and discoverable for first-time users.
            Sits well below the workspace selector so it doesn't crowd
            that zone, and well above the bottom UserMenu strip.
          */}
          <SidebarEdgeToggle isCollapsed={isCollapsed} />
        </nav>
      )}

      {/* Main content */}
      <main className="flex-1 h-dvh overflow-hidden bg-background text-foreground flex flex-col">
        {isHidden && (
          <header className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card shrink-0">
            <SidebarToggle />
            <Logo variant="full" height={22} />
          </header>
        )}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </main>

      {/* Mobile drawer */}
      {isHidden && (
        <MobileSidebarDrawer>
          <div className="flex flex-col h-full">
            {/* Mobile workspace identity */}
            <div className="px-1 pt-4 pb-1 shrink-0">
              <WorkspaceSelector collapsed={false} />
            </div>
            <div className="flex-1 overflow-y-auto py-1 sidebar-scroll">
              {/* Ungrouped core nav */}
              {ungrouped.map((p) => (
                <MobileNavItem
                  key={p.resourceUri}
                  to={resolveRoute(p, wsSlug)}
                  icon={p.icon}
                  label={p.label ?? "Item"}
                  end={p.route === "/"}
                />
              ))}

              {/* Grouped items */}
              {Object.entries(groups).map(([group, items]) => (
                <div key={group} className="mt-4 pt-3 border-t border-sidebar-border/60">
                  <div className="px-4 pb-1 text-[11px] font-bold tracking-[0.08em] text-sidebar-foreground/70 uppercase">
                    {group}
                  </div>
                  {items.map((p) => (
                    <MobileNavItem
                      key={p.resourceUri}
                      to={resolveRoute(p, wsSlug)}
                      icon={p.icon}
                      label={p.label ?? p.route ?? "Item"}
                    />
                  ))}
                </div>
              ))}
            </div>

            {/* Bottom pinned items + identity */}
            <div className="shrink-0 border-t border-sidebar-border py-2">
              {sidebarBottom.map((p) => (
                <MobileNavItem
                  key={p.resourceUri}
                  to={resolveRoute(p, wsSlug)}
                  icon={p.icon}
                  label={p.label ?? "Settings"}
                />
              ))}
              <UserMenu
                collapsed={false}
                onLogout={() => {
                  setDrawerOpen(false);
                  onLogout();
                }}
              />
            </div>
          </div>
        </MobileSidebarDrawer>
      )}
    </div>
  );
});

// --- Helpers ---

/** Resolve a placement to a route path for NavLink. */
function resolveRoute(p: PlacementEntry, wsSlug?: string): string {
  // Settings is a core page — /settings (not workspace-scoped)
  if (p.route === "settings") return "/settings";
  // Workspace-scoped routes
  const prefix = wsSlug ? `/w/${wsSlug}` : "";
  // Home gets workspace root
  if (p.route === "/") return prefix ? `${prefix}/` : "/";
  // Other routed placements get /w/<slug>/app/<route>
  if (p.route) return `${prefix}/app/${p.route}`;
  return "#";
}

// --- Components ---

function NavIcon({ name }: { name: string }) {
  const Icon = resolveIcon(name);
  return <Icon className="shrink-0" style={{ width: 18, height: 18 }} />;
}

/**
 * Edge-overflow collapse toggle.
 *
 * Anchored to the sidebar's right border, vertically centered;
 * half-overflows so the click target lives in the seam between sidebar
 * and main content. Doesn't occupy any in-sidebar real estate — sidebar
 * nav, workspace selector, and UserMenu are all unaffected.
 *
 * Vertical center is the right anchor: the dense zones at top (workspace
 * selector) and bottom (UserMenu) are claimed; centering reads as "this
 * controls the whole sidebar" rather than belonging to either zone.
 *
 * Always visible (not hover-required) so it's reachable on touch and
 * discoverable for first-time users.
 */
const SidebarEdgeToggle = memo(function SidebarEdgeToggle({
  isCollapsed,
}: {
  isCollapsed: boolean;
}) {
  const { toggle } = useSidebar();
  const Icon = isCollapsed ? ChevronRight : ChevronLeft;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={`${isCollapsed ? "Expand sidebar" : "Collapse sidebar"} (⌘B)`}
      className={cn(
        "absolute top-1/2 -translate-y-1/2 -right-3 z-30 w-6 h-6 rounded-full",
        "flex items-center justify-center",
        "bg-sidebar border border-sidebar-border shadow-sm",
        "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-foreground/10",
        "transition-colors",
      )}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
});

const NavItem = memo(function NavItem({
  to,
  icon,
  label,
  collapsed,
  end,
}: {
  to: string;
  icon?: string;
  label: string;
  collapsed?: boolean;
  end?: boolean;
}) {
  if (collapsed) {
    return (
      <NavLink
        to={to}
        end={end}
        title={label}
        className={({ isActive }) =>
          `flex items-center justify-center p-2.5 mx-2 rounded-lg text-sm font-medium transition-colors ${
            isActive
              ? "bg-sidebar-foreground/10 text-sidebar-foreground"
              : "text-sidebar-foreground hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground"
          }`
        }
      >
        {icon && <NavIcon name={icon} />}
      </NavLink>
    );
  }

  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 mx-2 rounded-lg text-sm font-medium transition-colors ${
          isActive
            ? "bg-sidebar-foreground/10 text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground"
        }`
      }
    >
      {icon && <NavIcon name={icon} />}
      <span className="flex-1 truncate">{label}</span>
    </NavLink>
  );
});

function MobileNavItem({
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
  const { setDrawerOpen } = useSidebar();
  return (
    <NavLink
      to={to}
      end={end}
      onClick={() => setDrawerOpen(false)}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 mx-2 rounded-lg text-sm font-medium transition-colors ${
          isActive
            ? "bg-sidebar-foreground/10 text-sidebar-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground"
        }`
      }
    >
      {icon && <NavIcon name={icon} />}
      <span className="flex-1 truncate">{label}</span>
    </NavLink>
  );
}

function GroupLabel({ children, collapsed }: { children: React.ReactNode; collapsed?: boolean }) {
  if (collapsed) {
    return <div className="mx-3 my-2 border-t border-sidebar-border" />;
  }
  return (
    <div className="px-4 pb-1 text-[11px] font-bold tracking-[0.08em] text-sidebar-foreground/70 uppercase">
      {children}
    </div>
  );
}

const SidebarGroup = memo(function SidebarGroup({
  label,
  items,
  collapsed,
  wsSlug,
}: {
  label: string;
  items: PlacementEntry[];
  collapsed?: boolean;
  wsSlug?: string;
}) {
  return (
    <div className={cn("mt-4", !collapsed && "pt-3 border-t border-sidebar-border/60")}>
      <GroupLabel collapsed={collapsed}>{label}</GroupLabel>
      {items.map((p) => (
        <NavItem
          key={p.resourceUri}
          to={resolveRoute(p, wsSlug)}
          icon={p.icon}
          label={p.label ?? p.route ?? "Item"}
          collapsed={collapsed}
        />
      ))}
    </div>
  );
});

/** Group placements by sub-slot. "sidebar.apps" → "apps", bare "sidebar" → "general" */
function groupBySubSlot(
  placements: PlacementEntry[],
  parentSlot: string,
): Record<string, PlacementEntry[]> {
  const groups: Record<string, PlacementEntry[]> = {};
  for (const p of placements) {
    const sub = p.slot.startsWith(`${parentSlot}.`)
      ? p.slot.slice(parentSlot.length + 1)
      : "general";
    if (!groups[sub]) groups[sub] = [];
    groups[sub].push(p);
  }
  return groups;
}
