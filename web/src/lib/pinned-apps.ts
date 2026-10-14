/**
 * Pinned apps: the apps a viewer keeps at the top of a workspace's APPS list.
 *
 * A per-browser preference (`local-pref.ts`), one per workspace, holding the
 * pinned connectors' `serverName`s in the order they were pinned. Losing it
 * only puts the apps back in priority order. A name that is no longer
 * installed is harmless; ordering ignores it.
 */

import { useCallback } from "react";
import { type LocalPref, parseStringList, toggleListItem, usePref } from "./local-pref";

function pref(workspaceId: string): LocalPref<readonly string[]> {
  return { key: `nb:pinned-apps:${workspaceId}`, parse: parseStringList, empty: [] };
}

export function togglePinnedApp(workspaceId: string, serverName: string): void {
  toggleListItem(pref(workspaceId), serverName);
}

export function usePinnedApps(workspaceId: string): {
  pinned: readonly string[];
  toggle: (serverName: string) => void;
} {
  const pinned = usePref(pref(workspaceId));
  const toggle = useCallback(
    (serverName: string) => togglePinnedApp(workspaceId, serverName),
    [workspaceId],
  );
  return { pinned, toggle };
}
