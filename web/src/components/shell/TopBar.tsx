// ---------------------------------------------------------------------------
// TopBar — the main area's header: what page this is, the way back up, the
// inbox, and Chat.
//
// Left: the page's title. When the routed app reports a trail deeper than its
// root (`ai.nimblebrain/location`, via `AppLocationContext`), the entries above
// the current view precede the title as a breadcrumb, and picking one asks the
// app to go there. A back button cannot reach two levels up, a breadcrumb names
// every level. Where the bar is too narrow for that, a back control to the
// entry before the last stands in. An app that places several views is one
// app in the sidebar, grouped by the host, so the host leads the trail with a
// crumb naming that app ("Outreach › Campaigns"), linked to its first view;
// each view's trail is rooted at the view and cannot name the app it sits in. Otherwise the title is the route's own name
// (`lib/page-title`); a settings tab's name follows a crumb back to its area
// ("Settings › Members"), linked to that area's first tab. On a phone, the menu
// button that opens the nav drawer leads the row.
//
// Right, on workspace routes: on an app with a settings section, a gear to
// its connector's settings page; then the inbox's bell, then Chat, which stays
// last.
// Neither holds a fill while its panel or page is open: they are ways in, not
// tabs, and a held fill reads as stuck. `aria-pressed` / `aria-current` carry
// the state for assistive tech.
//
// The left inset is the page gutter (`--page-gutter`), so the title lines up
// with an app's content and narrows with it.
//
// Height is the chat panel header's (`h-14`, border included), so the two
// bottom borders run on the same pixel row and meet at the resize handle.
// Change one, change both.
// ---------------------------------------------------------------------------

import { ArrowLeft, ChevronRight } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import type { AppTrailEntry } from "../../bridge/schemas";
import { useAppLocation } from "../../context/AppLocationContext";
import { useShellContext } from "../../context/ShellContext";
import { useSidebar } from "../../context/SidebarContext";
import { useWorkspaceAppIcons } from "../../context/WorkspaceAppIconsContext";
import { useWorkspaceContext } from "../../context/WorkspaceContext";
import { appDisplayName } from "../../lib/app-name";
import { pageTitle, settingsLocation } from "../../lib/page-title";
import { appForPath } from "../../lib/workspace-apps";
import { SidebarToggle } from "../SidebarToggle";
import { Tooltip, TooltipProvider } from "../ui/tooltip";
import { AppSettingsLink } from "./AppSettingsLink";
import { ChatToggle } from "./ChatToggle";
import { InboxToggle } from "./InboxToggle";

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

/** A crumb: an app's trail entry, which asks the app to go there, or a host route, which is a link. */
type Crumb = { label: string; onSelect: () => void } | { label: string; to: string };

/**
 * The crumb naming the routed app, when that app places several views; null
 * for a single-view app, off an app route, and while the shell still holds
 * another workspace's placements mid-switch. It reads the app's name by the
 * sidebar's rule (`appDisplayName` over the app's own views) and links to the
 * app's first view, where the sidebar entry opens it: the host's route, not one
 * of the app's trail ids.
 */
function useAppCrumb(pathname: string): Crumb | null {
  const shell = useShellContext();
  const { activeWorkspace } = useWorkspaceContext();
  const { connectors } = useWorkspaceAppIcons();
  if (!shell || !activeWorkspace || shell.shellWorkspaceId !== activeWorkspace.id) return null;
  const app = appForPath(pathname, shell.forSlot("sidebar"));
  const first = app?.views[0];
  if (!app || !first || app.views.length < 2) return null;
  const installed =
    connectors?.workspaceId === activeWorkspace.id ? connectors.installed : undefined;
  const slug = pathname.split("/").filter(Boolean)[1];
  return {
    label: appDisplayName(app.serverName, installed, app.views),
    to: `/w/${slug}/app/${first.route}`,
  };
}

/** A crumb's control: a link for a host route, a button for an app's trail entry. */
function CrumbControl({
  crumb,
  className,
  ariaLabel,
  testId,
  children,
}: {
  crumb: Crumb;
  className: string;
  ariaLabel?: string;
  testId: string;
  children: ReactNode;
}) {
  return "to" in crumb ? (
    <Link to={crumb.to} aria-label={ariaLabel} data-testid={testId} className={className}>
      {children}
    </Link>
  ) : (
    <button
      type="button"
      onClick={crumb.onSelect}
      aria-label={ariaLabel}
      data-testid={testId}
      className={className}
    >
      {children}
    </button>
  );
}

export function TopBar() {
  const { pathname } = useLocation();
  const { state: sidebarState } = useSidebar();
  const shell = useShellContext();
  const { appLocation } = useAppLocation();
  const appCrumb = useAppCrumb(pathname);

  const trail = appLocation?.trail ?? [];
  const current = trail[trail.length - 1];
  // An app's own trail wins; a settings route without one gets the host's. The
  // app crumb leads either way, outside the fold, which is the app's trail's.
  const crumbs: (Crumb | null)[] = [
    ...(appCrumb ? [appCrumb] : []),
    ...(trail.length > 1 && appLocation
      ? visibleAncestors(trail.slice(0, -1)).map(
          (entry) =>
            entry && { label: entry.label, onSelect: () => appLocation.navigate(entry.id) },
        )
      : (settingsLocation(pathname)?.crumbs ?? [])),
  ];
  // Back goes one step up: the last crumb, unless that is the page already open
  // (the app crumb on its first view's root).
  const parent = crumbs[crumbs.length - 1] ?? null;
  const back = parent && !("to" in parent && parent.to === pathname) ? parent : null;
  const title = current?.label ?? pageTitle(pathname, shell?.forSlot("sidebar") ?? []);

  return (
    <TooltipProvider>
      <header
        data-testid="top-bar"
        className="@container/top-bar flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background pr-3 pl-(--page-gutter)"
      >
        {sidebarState === "hidden" && <SidebarToggle />}
        {back && (
          // Narrow: one step up.
          <Tooltip label={`Back to ${back.label}`}>
            <CrumbControl
              crumb={back}
              ariaLabel={`Back to ${back.label}`}
              testId="top-bar-back"
              className="-ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-foreground/10 @lg/top-bar:hidden"
            >
              <ArrowLeft aria-hidden="true" className="size-[18px]" />
            </CrumbControl>
          </Tooltip>
        )}
        {crumbs.length > 0 && (
          // Wide: every level, by name.
          <nav
            aria-label="Breadcrumb"
            data-testid="top-bar-breadcrumb"
            className="-ml-1.5 hidden min-w-0 shrink @lg/top-bar:block"
          >
            <ol className="flex min-w-0 items-center">
              {crumbs.map((entry, i) => (
                // Keyed by position: ids are the app's and need not be unique.
                // biome-ignore lint/suspicious/noArrayIndexKey: the trail is replaced whole, never reordered
                <Fragment key={i}>
                  <li className="min-w-0" aria-hidden={entry ? undefined : true}>
                    {entry ? (
                      <CrumbControl
                        crumb={entry}
                        testId="top-bar-crumb"
                        className="block max-w-48 truncate rounded-md px-1.5 py-1 font-heading text-base text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                      >
                        {entry.label}
                      </CrumbControl>
                    ) : (
                      <span className="px-1 text-muted-foreground">…</span>
                    )}
                  </li>
                  <li aria-hidden="true" className="shrink-0 text-muted-foreground">
                    <ChevronRight className="size-3.5" />
                  </li>
                </Fragment>
              ))}
            </ol>
          </nav>
        )}
        {/* The page's heading: pages that lean on the bar for their name carry
            none of their own. The floor keeps it readable beside a long
            breadcrumb, which shrinks first. */}
        <h1
          data-testid="top-bar-title"
          className="min-w-32 flex-1 truncate font-heading text-base font-medium text-foreground"
        >
          {title}
        </h1>
        {pathname.startsWith("/w/") && (
          <>
            <AppSettingsLink />
            <InboxToggle />
            <ChatToggle />
          </>
        )}
      </header>
    </TooltipProvider>
  );
}
