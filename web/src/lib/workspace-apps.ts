import type { PlacementEntry } from "../types";
import { isIdentityApp } from "./identity-apps";

/**
 * Max apps shown inline under the focused workspace in the sidebar
 * before the "View all N apps" overflow link takes over, counted in apps
 * (see `appsByConnector`), not in the views an app places. The cap applies
 * after `orderApps` lifts the viewer's pinned apps to the top, so a pinned app
 * is always shown.
 */
export const MAX_INLINE_APPS = 10;

/**
 * The app placements for the focused workspace, derived from the shell
 * placement registry. "Apps" are the grouped sidebar placements
 * (`sidebar.<group>`, e.g. `sidebar.apps`); bare `sidebar` items are
 * core nav (Conversations, Files, …) and `sidebar.bottom` is the utility
 * tray — neither is an app. This is the filter the workspace overview
 * page already used, lifted into one shared, tested helper so the
 * sidebar quick-list and the overview grid show the same set. The grid
 * shows one card per placement; the sidebar and the "View all N apps"
 * count group them into apps with `appsByConnector`.
 *
 * One entry per placement (not per app) — a route is a navigable
 * destination, so callers key by `resourceUri`. Sorted by priority
 * (lower = higher) so a "top N" slice is meaningful regardless of the
 * caller's input order.
 *
 * Pass the result of `forSlot("sidebar")`.
 */
export function workspaceApps(sidebarPlacements: PlacementEntry[]): PlacementEntry[] {
  return sidebarPlacements
    .filter((p) => p.slot.startsWith("sidebar.") && !p.slot.startsWith("sidebar.bottom"))
    .sort((a, b) => a.priority - b.priority);
}

/** One app in the sidebar: a connector, and the views it placed there. */
export interface WorkspaceApp {
  serverName: string;
  /** Its placements in priority order. The first is where the app opens. */
  views: PlacementEntry[];
}

/**
 * The workspace's apps, one per connector, from `workspaceApps()`'s placements.
 *
 * A connector that places several views (`sidebar.<group>` placements, each with
 * its own route) is still one app: the nav lists it once and shows its views
 * beneath it, and the cap and the "View all N apps" count are in apps. A
 * connector with one placement is an app with one view, which renders as it
 * always has. Apps keep the order of their first placement.
 */
export function appsByConnector(placements: PlacementEntry[]): WorkspaceApp[] {
  const apps = new Map<string, WorkspaceApp>();
  for (const placement of placements) {
    const app = apps.get(placement.serverName);
    if (app) app.views.push(placement);
    else apps.set(placement.serverName, { serverName: placement.serverName, views: [placement] });
  }
  return [...apps.values()];
}

/**
 * The viewer's pinned apps first, in the order they were pinned, then the rest
 * in the order given. `pinned` holds `serverName`s (`lib/pinned-apps.ts`); a
 * name with no app here is ignored.
 */
export function orderApps(apps: WorkspaceApp[], pinned: readonly string[]): WorkspaceApp[] {
  if (pinned.length === 0) return apps;
  const rank = (app: WorkspaceApp) => {
    const i = pinned.indexOf(app.serverName);
    return i === -1 ? pinned.length : i;
  };
  // Array.prototype.sort is stable, so unpinned apps keep their order.
  return [...apps].sort((a, b) => rank(a) - rank(b));
}

/**
 * Project the installed-connector list into the `serverName → brand icon URL`
 * map the sidebar quick-list and overview grid consume. Connectors without an
 * `iconUrl` are omitted — callers fall back to a letter avatar. Pure (no React,
 * no fetch) so the map-building contract is testable without the provider's
 * fetch / SSE wiring; `WorkspaceAppIconsProvider` is the only caller.
 */
export function iconMapFromInstalled(
  installed: ReadonlyArray<{ serverName: string; iconUrl?: string }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of installed) {
    if (c.iconUrl) map.set(c.serverName, c.iconUrl);
  }
  return map;
}

/**
 * The settings page of an installed connector in a workspace:
 * `/w/<slug>/settings/connectors/<serverName>`. Null when there is no
 * workspace to put it in, or for an identity app, which has no workspace
 * settings page.
 */
export function connectorSettingsPath(
  slug: string | null | undefined,
  serverName: string,
): string | null {
  if (!slug || isIdentityApp(serverName)) return null;
  return `/w/${slug}/settings/connectors/${encodeURIComponent(serverName)}`;
}
