import { ChevronLeft, ChevronRight } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { useChatPanelContext } from "../context/ChatPanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { identityAppRoute, isIdentityApp } from "../lib/identity-apps";
import { resolveIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { toSlug } from "../lib/workspace-slug";
import type { PlacementEntry } from "../types";
import { ChatChrome } from "./ChatChrome";
import { Logo } from "./Logo";
import { MobileSidebarDrawer } from "./MobileSidebarDrawer";
import { SidebarSearch } from "./shell/SidebarSearch";
import { WorkspaceSection } from "./shell/WorkspaceSection";
import { SidebarToggle } from "./SidebarToggle";
import { UserMenu } from "./UserMenu";

/**
 * Priority threshold for core sidebar items. Items in the bare
 * "sidebar" slot with priority < 10 render as ungrouped core nav
 * (Home, Conversations, Automations, Files). Priority >= 10 items —
 * historically the "Apps" sub-slot group at the bottom of the sidebar —
 * are no longer rendered here; apps live on the workspace overview
 * page (`/w/<slug>/`) instead.
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
 * Sidebar zones (top → bottom):
 *   1. Identity (UserMenu)
 *   2. Search stub (⌘P)
 *   3. Core nav: Home, Conversations, Automations, Files (global,
 *      identity-bound, cross-workspace)
 *   4. WORKSPACES section — workspaces are a sibling category to the
 *      core nav, not a parent column. Click a workspace row =
 *      navigate to its overview at `/w/<slug>/`. No inline apps.
 *
 * The former bottom "APPS" group is gone — apps surface on each
 * workspace's overview page now.
 */
// Chat panel transition timings — kept in lockstep with `ChatChrome` so
// the main content's marginRight slides in sync with the panel itself.
// Any divergence here is what was making the post-lift animation look
// "jerky": the chat panel was animating but the content underneath
// wasn't moving in coordination.
const CHAT_TRANSITION_STANDARD = "300ms cubic-bezier(0.33, 1, 0.68, 1)";
const CHAT_RESIZE_HANDLE_WIDTH = 4; // px — matches ChatChrome's ResizeHandle

function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 768,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isMobile;
}

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

  // Chat-panel coordination — every route's main area pushes over by
  // `panelWidth` when the chat panel is in sidebar mode (matches the
  // pre-refactor AppWithChat behavior; lifted here so workspace
  // overview, global home, settings, etc. all coordinate identically).
  const chatPanel = useChatPanelContext();
  const isMobile = useIsMobile();
  const chatIsSidebar = chatPanel.panelState === "sidebar";
  const mainMarginRight =
    chatIsSidebar && !isMobile ? chatPanel.panelWidth + CHAT_RESIZE_HANDLE_WIDTH : 0;

  // Ungrouped core items: bare "sidebar" slot with priority < threshold.
  // Grouped items (formerly the bottom "APPS" group, sourced from
  // `sidebar.<group>` sub-slots) are no longer rendered in the sidebar —
  // apps live on the workspace overview page (`/w/<slug>/`) now.
  const ungrouped = forSlot("sidebar").filter(
    (p) => p.slot === "sidebar" && p.priority < UNGROUPED_PRIORITY_THRESHOLD,
  );

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
          {/* Identity (top-left) — anchors the sidebar; dropdown opens
              downward over the rest of the sidebar. */}
          <div className="shrink-0 py-2">
            <UserMenu collapsed={isCollapsed} onLogout={onLogout} />
          </div>

          {/* Search stub (⌘P focuses; palette behavior lands in a later
              session). Hidden when the sidebar is collapsed to icon-only. */}
          {!isCollapsed && <SidebarSearch />}

          {/* Scrolling region — key triggers fade-in on workspace switch */}
          <div key={wsSlug} className="flex-1 overflow-y-auto py-1 sidebar-scroll sidebar-nav-fade">
            {/* Core nav (Home, Conversations, Automations, Files) —
                global, identity-bound. Siblings of workspaces. */}
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

            {/* WORKSPACES section — sibling category to the core nav,
                rendered with a labelled header (Linear / Notion
                pattern) so the visual cue is "different kind of
                thing," not "parent column." */}
            <WorkspaceSection collapsed={isCollapsed} />
          </div>

          {/*
            Edge collapse toggle — anchored to the sidebar's right border,
            half-overflowing. Always visible (rather than hover-only) so
            it's reachable on touch and discoverable for first-time users.
          */}
          <SidebarEdgeToggle isCollapsed={isCollapsed} />
        </nav>
      )}

      {/* Main content — pushes over to make room for the chat panel
          when it's open in sidebar mode. The marginRight + transition
          here is what every route now relies on (was previously
          duplicated only inside AppWithChat). Mobile / fullscreen
          modes don't need this push: mobile chat is full-width;
          fullscreen chat covers the content overlay-style. */}
      <main
        className="flex-1 h-dvh overflow-hidden bg-background text-foreground flex flex-col"
        style={{
          marginRight: mainMarginRight,
          transition: `margin-right ${CHAT_TRANSITION_STANDARD}`,
        }}
      >
        {isHidden && (
          <header className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card shrink-0">
            <SidebarToggle />
            <Logo variant="full" height={22} />
          </header>
        )}
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </main>

      {/* Chat chrome (toggle + sliding panel + resize handle) — the
          single, global mount point, so chat is one click away from any
          route. The push-over that makes room for the panel is the
          `marginRight` on <main> above; the panel and handle live inside
          ChatChrome itself. */}
      <ChatChrome />

      {/* Mobile drawer — single-column layout mirroring desktop. */}
      {isHidden && (
        <MobileSidebarDrawer>
          <div className="flex flex-col h-full">
            {/* Identity at top */}
            <div className="shrink-0 py-2">
              <UserMenu
                collapsed={false}
                onLogout={() => {
                  setDrawerOpen(false);
                  onLogout();
                }}
              />
            </div>

            {/* Search stub */}
            <SidebarSearch />

            <div className="flex-1 overflow-y-auto py-1 sidebar-scroll">
              {/* Core nav — siblings of workspaces, not parents. */}
              {ungrouped.map((p) => (
                <MobileNavItem
                  key={p.resourceUri}
                  to={resolveRoute(p, wsSlug)}
                  icon={p.icon}
                  label={p.label ?? "Item"}
                  end={p.route === "/"}
                />
              ))}

              {/* WORKSPACES section */}
              <WorkspaceSection />
            </div>

            {/* Bottom pinned items (sidebar.bottom placements;
                settings is accessed via the UserMenu dropdown). */}
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
  // Home is now the global landing at `/` (was workspace-scoped). The
  // workspace overview lives at `/w/<slug>/` and is reached by clicking
  // the workspace row directly.
  if (p.route === "/") return "/";
  // Identity apps (conversations, …) are owned by the user and live OUTSIDE
  // any workspace — they render at a top-level root route (e.g.
  // `/conversations`), never under `/w/<slug>`. Location is scope.
  if (isIdentityApp(p.serverName)) return identityAppRoute(p.serverName);
  // Other routed placements get /w/<slug>/app/<route>
  const prefix = wsSlug ? `/w/${wsSlug}` : "";
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
