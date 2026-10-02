// ---------------------------------------------------------------------------
// TopBar — the main area's header: what page this is, the way back up, and Chat.
//
// Left: the page's title. When the routed app reports a trail deeper than its
// root (`ai.nimblebrain/location`, via `AppLocationContext`), the entries above
// the current view precede the title as a breadcrumb, and picking one asks the
// app to go there. A back button cannot reach two levels up, a breadcrumb names
// every level. Where the bar is too narrow for that, a back control to the
// entry before the last stands in. Otherwise the title is the route's own name
// (`lib/page-title`), with neither. On a phone, the menu button that opens the
// nav drawer leads the row.
//
// Right: Chat, on workspace routes, where chat exists.
//
// Height is the chat panel header's (`h-14`, border included), so the two
// bottom borders run on the same pixel row and meet at the resize handle.
// Change one, change both.
// ---------------------------------------------------------------------------

import { ArrowLeft, ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { useLocation } from "react-router-dom";
import type { AppTrailEntry } from "../../bridge/schemas";
import { useAppLocation } from "../../context/AppLocationContext";
import { useShellContext } from "../../context/ShellContext";
import { useSidebar } from "../../context/SidebarContext";
import { pageTitle } from "../../lib/page-title";
import { SidebarToggle } from "../SidebarToggle";
import { Tooltip, TooltipProvider } from "../ui/tooltip";
import { ChatToggle } from "./ChatToggle";

/** Above this many ancestors, the middle ones fold into an ellipsis. */
const MAX_ANCESTORS = 3;

/**
 * The ancestors the breadcrumb shows: all of them, or the root and the parent
 * around a `null` gap. The parent stays because it is one step up; the root
 * stays because it is where the app starts. A folded level is still reachable
 * by walking up through the parent.
 */
function visibleAncestors(ancestors: AppTrailEntry[]): (AppTrailEntry | null)[] {
  if (ancestors.length <= MAX_ANCESTORS) return ancestors;
  return [ancestors[0], null, ancestors[ancestors.length - 1]];
}

export function TopBar() {
  const { pathname } = useLocation();
  const { state: sidebarState } = useSidebar();
  const shell = useShellContext();
  const { appLocation } = useAppLocation();

  const trail = appLocation?.trail ?? [];
  const current = trail[trail.length - 1];
  const ancestors = trail.slice(0, -1);
  const parent = ancestors[ancestors.length - 1];
  const title = current?.label ?? pageTitle(pathname, shell?.forSlot("sidebar") ?? []);

  return (
    <TooltipProvider>
      <header
        data-testid="top-bar"
        className="@container/top-bar flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background pr-3 pl-4"
      >
        {sidebarState === "hidden" && <SidebarToggle />}
        {parent && appLocation && (
          <>
            {/* Narrow: one step up. */}
            <Tooltip label={`Back to ${parent.label}`}>
              <button
                type="button"
                onClick={() => appLocation.navigate(parent.id)}
                aria-label={`Back to ${parent.label}`}
                data-testid="top-bar-back"
                className="-ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-foreground/10 @lg/top-bar:hidden"
              >
                <ArrowLeft aria-hidden="true" className="size-[18px]" />
              </button>
            </Tooltip>
            {/* Wide: every level, by name. */}
            <nav
              aria-label="Breadcrumb"
              data-testid="top-bar-breadcrumb"
              className="-ml-1.5 hidden min-w-0 shrink @lg/top-bar:block"
            >
              <ol className="flex min-w-0 items-center">
                {visibleAncestors(ancestors).map((entry, i) => (
                  <Fragment key={entry?.id ?? `gap-${i}`}>
                    <li className="min-w-0">
                      {entry ? (
                        <button
                          type="button"
                          onClick={() => appLocation.navigate(entry.id)}
                          data-testid="top-bar-crumb"
                          className="block max-w-48 truncate rounded-md px-1.5 py-1 font-heading text-base text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                        >
                          {entry.label}
                        </button>
                      ) : (
                        <span aria-hidden="true" className="px-1 text-muted-foreground">
                          …
                        </span>
                      )}
                    </li>
                    <li aria-hidden="true" className="shrink-0 text-muted-foreground">
                      <ChevronRight className="size-3.5" />
                    </li>
                  </Fragment>
                ))}
              </ol>
            </nav>
          </>
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
