import { memo, useEffect } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useChatPanelContext } from "../context/ChatPanelContext";
import { useSidebar } from "../context/SidebarContext";
import { useWorkspaceContext } from "../context/WorkspaceContext";
import { useIsMobile } from "../lib/hooks/use-is-mobile";
import { resolveIcon } from "../lib/icons";
import { cn } from "../lib/utils";
import { toSlug } from "../lib/workspace-slug";
import type { PlacementEntry } from "../types";
import { ArtifactPanel } from "./ArtifactPanel";
import { ChatChrome } from "./ChatChrome";
import { HelpMenu } from "./HelpMenu";
import { MobileSidebarDrawer } from "./MobileSidebarDrawer";
import { NoticeViewport } from "./notices";
import { ReleaseUpdateBanner } from "./ReleaseUpdateBanner";
import { SidebarHeader } from "./shell/SidebarHeader";
import { TopBar } from "./shell/TopBar";
import { WorkspaceNav } from "./shell/WorkspaceNav";
import { WorkspaceSwitcher } from "./shell/WorkspaceSwitcher";
import { UserMenu } from "./UserMenu";
import { TooltipProvider } from "./ui/tooltip";

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
 *   1. Header (`SidebarHeader`) — logo, search (⌘K), sidebar toggle (⌘B).
 *   2. Workspace (`WorkspaceSwitcher`) — names the workspace you're in and
 *      switches to another.
 *   3. That workspace's views (`WorkspaceNav`) — the whole nav body. There is
 *      no global core-nav row, because those views are workspace-scoped.
 *   4. Foot: help (`HelpMenu`), then the account (`UserMenu`) — who you are.
 */
// Chat panel transition timings — kept in lockstep with `ChatChrome` so
// the main content's marginRight slides in sync with the panel itself.
// Any divergence here is what was making the post-lift animation look
// "jerky": the chat panel was animating but the content underneath
// wasn't moving in coordination.
const CHAT_TRANSITION_STANDARD = "300ms cubic-bezier(0.33, 1, 0.68, 1)";
const CHAT_RESIZE_HANDLE_WIDTH = 4; // px — matches ChatChrome's ResizeHandle

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
  // Chat lives ONLY inside a workspace: the panel and its layout push-over
  // render only on `/w/:slug` routes. The identity/home surfaces (`/`,
  // `/profile/*`) are management-only — no chat. `ChatProvider` /
  // `ChatPanelProvider` stay mounted app-wide (cheap, and `/w/:slug` needs
  // them); only the rendering is gated.
  const isWorkspaceRoute = useLocation().pathname.startsWith("/w/");
  const chatIsSidebar = chatPanel.panelState === "sidebar";
  const mainMarginRight =
    isWorkspaceRoute && chatIsSidebar && !isMobile
      ? chatPanel.panelWidth + CHAT_RESIZE_HANDLE_WIDTH
      : 0;

  // Reset the chat panel when leaving a workspace so its state doesn't carry
  // into (or silently reopen on return from) the home / profile surfaces.
  // Lives here — ShellLayout is always mounted, whereas `ChatChrome` unmounts
  // on the transition off `/w/` and so can't reliably fire this itself. Panel
  // state persists across workspace→workspace navigation (both are `/w/`).
  const closeChat = chatPanel.closePanel;
  useEffect(() => {
    if (!isWorkspaceRoute) closeChat();
  }, [isWorkspaceRoute, closeChat]);

  // Sidebar bottom items: pinned to bottom, excluding settings (now in workspace dropdown)
  const sidebarBottom = forSlot("sidebar.bottom").filter((p) => p.route !== "settings");

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Desktop / tablet sidebar */}
      {!isHidden && (
        <nav
          aria-label="Workspace"
          className={cn(
            "shrink-0 h-dvh flex flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border transition-[width] duration-200",
            isCollapsed ? "w-16" : "w-60",
          )}
        >
          <SidebarBody collapsed={isCollapsed} onLogout={onLogout} />
        </nav>
      )}

      {/* Main content — pushes over to make room for the chat panel
          when it's open in sidebar mode. The marginRight + transition
          here is what every route now relies on (was previously
          duplicated only inside AppWithChat). Mobile / fullscreen
          modes don't need this push: mobile chat is full-width;
          fullscreen chat covers the content overlay-style. */}
      <main
        className="relative flex-1 h-dvh overflow-hidden bg-background text-foreground flex flex-col"
        style={{
          marginRight: mainMarginRight,
          transition: `margin-right ${CHAT_TRANSITION_STANDARD}`,
        }}
      >
        <TopBar />
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
        <NoticeViewport />
      </main>

      {/* Chat chrome (toggle + sliding panel + resize handle) — the single,
          global mount point, gated to workspace routes: chat exists only
          inside a workspace, so home / profile render no panel. The push-over
          that makes room for the panel is the `marginRight` on <main> above;
          the panel and handle live inside ChatChrome itself. */}
      {isWorkspaceRoute && <ChatChrome />}

      {/* Artifact document panel — the single, global mount point (sibling
          of ChatChrome), so an artifact chip in any conversation opens its
          report into one shared right-side drawer. Renders nothing until an
          artifact is opened via ArtifactPanelContext. */}
      <ArtifactPanel />

      {/* Mobile drawer — single-column layout mirroring desktop. */}
      {isHidden && (
        <MobileSidebarDrawer>
          <div className="flex flex-col h-full">
            <SidebarBody
              collapsed={false}
              onLogout={() => {
                setDrawerOpen(false);
                onLogout();
              }}
              // Bottom pinned items (sidebar.bottom placements; settings is
              // reached from the workspace switcher).
              tray={
                sidebarBottom.length > 0 && (
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
                )
              }
            />
          </div>
        </MobileSidebarDrawer>
      )}
    </div>
  );
});

// --- Helpers ---

/**
 * Resolve a `sidebar.bottom` placement to a route path for its MobileNavItem.
 * The workspace tree (`WorkspaceNav`) handles all the in-body nav now; this is
 * only the bottom utility tray (settings + any pinned app placements).
 */
function resolveRoute(p: PlacementEntry, wsSlug?: string): string {
  // Settings is workspace-scoped — `/w/<slug>/settings`. With no workspace
  // in scope there's no settings page to link to, so fall back to home.
  if (p.route === "settings") return wsSlug ? `/w/${wsSlug}/settings` : "/";
  if (p.route === "/") return "/";
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
 * The sidebar's contents, shared by the desktop sidebar and the mobile drawer
 * so both read the same top to bottom.
 */
function SidebarBody({
  collapsed,
  onLogout,
  tray,
}: {
  collapsed: boolean;
  onLogout: () => void;
  tray?: React.ReactNode;
}) {
  return (
    <TooltipProvider>
      <SidebarHeader collapsed={collapsed} />
      <div className={cn("shrink-0", collapsed ? "pb-1" : "pt-2 pb-3")}>
        <WorkspaceSwitcher collapsed={collapsed} />
      </div>

      {/* Scrolling region. Must NOT remount on a workspace switch (no
          `key={wsSlug}`): a switch swaps the routed hrefs in place, and
          remounting flashed the whole left nav. The fade-in runs once, on
          initial mount. */}
      <div className="flex-1 overflow-y-auto pb-2 sidebar-scroll sidebar-nav-fade">
        <WorkspaceNav collapsed={collapsed} />
      </div>

      {tray}

      {/* New-build-available prompt — renders nothing until detected. */}
      <ReleaseUpdateBanner collapsed={collapsed} />

      <div className="shrink-0 border-t border-sidebar-border py-2">
        <HelpMenu collapsed={collapsed} />
        <UserMenu collapsed={collapsed} onLogout={onLogout} />
      </div>
    </TooltipProvider>
  );
}

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
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 mx-2 rounded-sm text-sm transition-colors ${
          isActive
            ? "bg-sidebar-foreground/10 font-medium text-foreground"
            : "font-normal hover:bg-sidebar-foreground/5"
        }`
      }
    >
      {icon && <NavIcon name={icon} />}
      <span className="flex-1 truncate">{label}</span>
    </NavLink>
  );
}
