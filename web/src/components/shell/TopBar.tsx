// ---------------------------------------------------------------------------
// TopBar — the main area's header: what page this is, a way back up, and Chat.
//
// Left: the page's title. When the routed app reports a trail deeper than its
// root (`ai.nimblebrain/location`, via `AppLocationContext`), a back control
// precedes it and asks the app to go to the entry before the last. Otherwise
// the title is the route's own name (`lib/page-title`), and there is no back.
// On a phone, the menu button that opens the nav drawer leads the row.
//
// Right: Chat, on workspace routes, where chat exists.
//
// Height is the chat panel header's (`h-14`, border included), so the two
// bottom borders run on the same pixel row and meet at the resize handle.
// Change one, change both.
// ---------------------------------------------------------------------------

import { ArrowLeft } from "lucide-react";
import { useLocation } from "react-router-dom";
import { useAppLocation } from "../../context/AppLocationContext";
import { useShellContext } from "../../context/ShellContext";
import { useSidebar } from "../../context/SidebarContext";
import { pageTitle } from "../../lib/page-title";
import { SidebarToggle } from "../SidebarToggle";
import { Tooltip, TooltipProvider } from "../ui/tooltip";
import { ChatToggle } from "./ChatToggle";

export function TopBar() {
  const { pathname } = useLocation();
  const { state: sidebarState } = useSidebar();
  const shell = useShellContext();
  const { appLocation } = useAppLocation();

  const trail = appLocation?.trail;
  const current = trail?.[trail.length - 1];
  const parent = trail && trail.length > 1 ? trail[trail.length - 2] : undefined;
  const title = current?.label ?? pageTitle(pathname, shell?.forSlot("sidebar") ?? []);

  return (
    <TooltipProvider>
      <header
        data-testid="top-bar"
        className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background pr-3 pl-4"
      >
        {sidebarState === "hidden" && <SidebarToggle />}
        {parent && appLocation && (
          <Tooltip label={`Back to ${parent.label}`}>
            <button
              type="button"
              onClick={() => appLocation.navigate(parent.id)}
              aria-label={`Back to ${parent.label}`}
              data-testid="top-bar-back"
              className="-ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-foreground/10"
            >
              <ArrowLeft aria-hidden="true" className="size-[18px]" />
            </button>
          </Tooltip>
        )}
        {/* The page's heading: pages that lean on the bar for their name carry
            none of their own. */}
        <h1
          data-testid="top-bar-title"
          className="min-w-0 flex-1 truncate font-heading text-base font-medium text-foreground"
        >
          {title}
        </h1>
        {pathname.startsWith("/w/") && <ChatToggle />}
      </header>
    </TooltipProvider>
  );
}
