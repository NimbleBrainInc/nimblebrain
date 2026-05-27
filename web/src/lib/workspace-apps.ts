import type { PlacementEntry } from "../types";

/**
 * Max apps shown inline under the focused workspace in the sidebar
 * before the "View all N apps" overflow link takes over. Pinning /
 * recency are future work; for now this is a simple priority-ordered
 * top-N.
 */
export const MAX_INLINE_APPS = 4;

/**
 * The app placements for the focused workspace, derived from the shell
 * placement registry. "Apps" are the grouped sidebar placements
 * (`sidebar.<group>`, e.g. `sidebar.apps`); bare `sidebar` items are
 * core nav (Home, Conversations, …) and `sidebar.bottom` is the utility
 * tray — neither is an app. This is the filter the workspace overview
 * page already used, lifted into one shared, tested helper so the
 * sidebar quick-list and the overview grid show the same set and the
 * "View all N apps" count matches the grid by construction.
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
