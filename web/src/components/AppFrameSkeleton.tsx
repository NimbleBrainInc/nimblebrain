import { getInitialState } from "../context/SidebarContext";
import { cn } from "../lib/utils";

/**
 * The app's frame while the first sign-in check is in flight: the sidebar
 * column and the top bar at the size and place the shell will draw them, with
 * nothing in them. A refresh then keeps its layout instead of flashing a blank
 * page with "Loading..." in the middle.
 *
 * It holds no data. Until the check answers, the app does not know whose
 * workspaces to list, or whether to show the login page instead, so the frame
 * shows only what every outcome but the login page shares. It does not animate.
 */
export function AppFrameSkeleton() {
  const sidebar = getInitialState();
  return (
    <div className="flex h-dvh overflow-hidden bg-background" data-testid="app-frame-skeleton">
      {sidebar !== "hidden" && (
        <div
          aria-hidden="true"
          className={cn(
            "shrink-0 h-dvh bg-sidebar border-r border-sidebar-border",
            sidebar === "collapsed" ? "w-16" : "w-60",
          )}
        />
      )}
      <div className="flex-1 h-dvh flex flex-col" role="status">
        <div aria-hidden="true" className="h-14 shrink-0 border-b border-border" />
        <span className="sr-only">Loading…</span>
      </div>
    </div>
  );
}
