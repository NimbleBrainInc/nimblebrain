import { memo } from "react";
import { NavLink } from "react-router-dom";
import { useSidebar } from "../context/SidebarContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { resolveIcon } from "../lib/icons";
import { toSlug } from "../lib/workspace-slug";
import type { PlacementEntry } from "../types";
import { Logo } from "./Logo";
import { MobileSidebarDrawer } from "./MobileSidebarDrawer";
import { SidebarToggle } from "./SidebarToggle";
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
          className={`${isCollapsed ? "w-16" : "w-60"} shrink-0 h-dvh flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border transition-[width] duration-200`}
        >
          {/* Workspace identity */}
          <div className={`${isCollapsed ? "px-0 pt-3 pb-1" : "px-1 pt-3 pb-1"} shrink-0`}>
            <WorkspaceSelector collapsed={isCollapsed} onLogout={onLogout} />
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

          {/* Bottom zone — sidebar toggle */}
          <div
            className={`shrink-0 border-t border-sidebar-border py-2 px-2 flex ${isCollapsed ? "justify-center" : "justify-end"}`}
          >
            <SidebarToggle />
          </div>
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
              <WorkspaceSelector
                collapsed={false}
                onLogout={() => {
                  setDrawerOpen(false);
                  onLogout();
                }}
              />
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
                <div key={group} className="mt-4">
                  <div className="px-4 py-1.5 text-[11px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase">
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

            {/* Bottom pinned items */}
            {sidebarBottom.length > 0 && (
              <div className="shrink-0 border-t border-sidebar-border py-2">
                {sidebarBottom.map((p) => (
                  <MobileNavItem
                    key={p.resourceUri}
                    to={resolveRoute(p, wsSlug)}
                    icon={p.icon}
                    label={p.label ?? "Settings"}
                  />
                ))}
              </div>
            )}
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
    <div className="px-4 py-1.5 text-[11px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase">
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
    <div className="mt-4">
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
