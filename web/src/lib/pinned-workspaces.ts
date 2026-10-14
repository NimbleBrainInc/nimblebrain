/**
 * Pinned workspaces: the ones a viewer keeps at the top of the home grid.
 *
 * A per-browser preference (`local-pref.ts`): losing it only puts the
 * workspaces back in alphabetical order. Ids that no longer name one of the
 * viewer's workspaces are harmless; ordering ignores them.
 */

import { useMemo } from "react";
import { type LocalPref, parseStringList, toggleListItem, usePref } from "./local-pref";

const PREF: LocalPref<readonly string[]> = {
  key: "nb:pinned-workspaces",
  parse: parseStringList,
  empty: [],
};

function togglePinnedWorkspace(workspaceId: string): void {
  toggleListItem(PREF, workspaceId);
}

export function usePinnedWorkspaces(): {
  pinned: ReadonlySet<string>;
  toggle: (workspaceId: string) => void;
} {
  const list = usePref(PREF);
  const pinned = useMemo(() => new Set(list), [list]);
  return { pinned, toggle: togglePinnedWorkspace };
}
