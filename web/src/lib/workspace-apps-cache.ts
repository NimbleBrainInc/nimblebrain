// ---------------------------------------------------------------------------
// Last-known workspace apps — a per-workspace cache of the overview/sidebar app
// set, module-level so it survives the page unmounting and (more importantly) a
// workspace switch.
//
// The shell holds ONE workspace's placements at a time and lags a switch
// (`ShellContext.shellWorkspaceId`), so the overview can't read the new
// workspace's apps from `forSlot()` until the shell catches up — that gap is
// what made the grid flash a skeleton on every switch. Remembering each
// workspace's last-known app set lets a revisit paint THAT workspace's real
// cards immediately (correct data — keyed by its own id), and the fresh set
// replaces it the instant the shell catches up. A first visit (no entry) still
// falls back to the skeleton.
// ---------------------------------------------------------------------------

import type { PlacementEntry } from "../types";

const cache = new Map<string, PlacementEntry[]>();

/** Record the app set resolved for a workspace (only call when it's fresh). */
export function rememberWorkspaceApps(workspaceId: string, apps: PlacementEntry[]): void {
  cache.set(workspaceId, apps);
}

/** The last-known app set for a workspace, or null if never resolved here. */
export function lastKnownWorkspaceApps(workspaceId: string): PlacementEntry[] | null {
  return cache.get(workspaceId) ?? null;
}

/** Test-only: clear the cross-render cache for deterministic suites. */
export function __resetWorkspaceAppsCache(): void {
  cache.clear();
}
