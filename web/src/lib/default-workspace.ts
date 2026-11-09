/**
 * The default workspace: the one a viewer chose to open when the app loads at `/`.
 *
 * A per-browser preference (`local-pref.ts`), set and cleared from the home
 * grid. It is the viewer's own choice, never a workspace the shell picks, and it
 * only sends the viewer to that workspace's `/w/<id>` URL, which still names the
 * workspace (ADR-0060). An id that no longer names one of the viewer's
 * workspaces is ignored, so leaving the workspace restores the grid.
 */

import { type LocalPref, usePref, writePref } from "./local-pref";

const PREF: LocalPref<string | null> = {
  key: "nb:default-workspace",
  parse: (stored) => (typeof stored === "string" && stored.length > 0 ? stored : null),
  empty: null,
};

/** Make `workspaceId` the default, or clear it if it already is. At most one is the default. */
function toggleDefaultWorkspace(current: string | null, workspaceId: string): void {
  writePref(PREF, current === workspaceId ? null : workspaceId);
}

export function useDefaultWorkspace(): {
  defaultId: string | null;
  toggle: (workspaceId: string) => void;
} {
  const defaultId = usePref(PREF);
  return { defaultId, toggle: (workspaceId) => toggleDefaultWorkspace(defaultId, workspaceId) };
}
