/**
 * The last workspace: the one this browser was last in, and so where `/` opens.
 *
 * A per-browser preference (`local-pref.ts`), written each time a `/w/<id>`
 * page focuses a workspace the viewer belongs to. It is read only to choose
 * which `/w/<id>` URL to open (the redirect at `/`, and the old profile
 * addresses that redirect into a workspace); nothing reads it to scope a
 * request, so the URL stays the only thing that names a workspace (ADR-0073).
 */

import type { WorkspaceInfo } from "../context/WorkspaceContext";
import { type LocalPref, readPref, writePref } from "./local-pref";
import { orderWorkspacesForSidebar } from "./workspace-order";

const PREF: LocalPref<string | null> = {
  key: "nb:last-workspace",
  parse: (stored) => (typeof stored === "string" && stored.length > 0 ? stored : null),
  empty: null,
};

export function readLastWorkspace(): string | null {
  return readPref(PREF);
}

/** Record `workspaceId` as the one this browser is in. */
export function rememberWorkspace(workspaceId: string): void {
  if (readPref(PREF) !== workspaceId) writePref(PREF, workspaceId);
}

/**
 * Where `/` opens: the last workspace while the viewer is still a member, else
 * the first in the switcher's order, else none (a viewer in no workspace).
 */
export function landingWorkspace(
  workspaces: readonly WorkspaceInfo[],
  lastId: string | null,
): WorkspaceInfo | null {
  return (
    workspaces.find((ws) => ws.id === lastId) ?? orderWorkspacesForSidebar(workspaces)[0] ?? null
  );
}
