// ---------------------------------------------------------------------------
// The page on screen as telemetry names it: the route template the router
// matched (`/w/:slug/settings/members`), never the path it matched. A path names
// a workspace, a conversation or a record; a template names only the page.
//
// Pure: the router's route objects and a pathname in, the view out. The shell
// derives it once, at the router (`TrackedRoutes`), and `telemetry.ts` sends it.
// ---------------------------------------------------------------------------

import { matchRoutes, type RouteObject } from "react-router-dom";

/** What a route's `handle` tells telemetry about the page it renders. */
export interface RouteHandle {
  /**
   * The app the route renders, by server name. A server name comes from the
   * operator's catalog (a slug of the catalog id) or a platform source, never
   * from a person, so it is a product name, not content.
   */
  app?: string;
}

/** The page on screen, as its template. */
export interface RouteView {
  /** The matched route patterns joined, e.g. `/w/:slug/app/crm`. */
  template: string;
  /** The app the page renders, from the matched route's `handle`. */
  app?: string;
}

/** The view `pathname` opens in `routes`, or `null` when no route matches it. */
export function routeViewOf(routes: RouteObject[], pathname: string): RouteView | null {
  const matches = matchRoutes(routes, pathname);
  if (!matches) return null;
  let template = "";
  let app: string | undefined;
  for (const { route } of matches) {
    // An index or layout route without a path adds no segment.
    if (route.path) {
      template = route.path.startsWith("/")
        ? route.path
        : `${template.replace(/\/$/, "")}/${route.path}`;
    }
    const handle = route.handle as RouteHandle | undefined;
    if (handle?.app) app = handle.app;
  }
  return { template: template || "/", ...(app ? { app } : {}) };
}
