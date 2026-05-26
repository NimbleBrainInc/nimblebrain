// ---------------------------------------------------------------------------
// recoverFromWorkspaceError — workspace_error recovery logic
//
// The branching half of the workspace_error net (App.tsx wires this to the
// onWorkspaceError hook). Tested directly with injected side effects so the
// fallback selection, the exclusion of the rejected workspace, and the bail
// guard are all covered without rendering the shell.
// ---------------------------------------------------------------------------

import { describe, expect, mock, test } from "bun:test";
import type { WorkspaceInfo } from "../context/WorkspaceContext";
import { recoverFromWorkspaceError } from "./workspace-recovery";

function ws(id: string, opts: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { id, name: id, memberCount: 1, bundles: [], ...opts };
}

describe("recoverFromWorkspaceError", () => {
  test("prefers the personal workspace (excluding the rejected one)", () => {
    const setActive = mock((_ws: WorkspaceInfo) => {});
    const goHome = mock(() => {});

    const list = [ws("ws_shared"), ws("ws_personal", { isPersonal: true })];
    recoverFromWorkspaceError(list, "ws_shared", setActive, goHome);

    expect(setActive).toHaveBeenCalledTimes(1);
    expect(setActive.mock.calls[0][0].id).toBe("ws_personal");
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  test("falls back to the first non-rejected workspace when there is no personal one", () => {
    const setActive = mock((_ws: WorkspaceInfo) => {});
    const goHome = mock(() => {});

    const list = [ws("ws_a"), ws("ws_b")];
    recoverFromWorkspaceError(list, "ws_a", setActive, goHome);

    expect(setActive.mock.calls[0][0].id).toBe("ws_b");
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  test("never re-selects the rejected workspace even when it is first in the list", () => {
    // The pathological case the exclusion guards: a stale cached list with no
    // personal workspace where the rejected (active) id is workspaces[0].
    // Without the exclusion this would re-select the same bad id.
    const setActive = mock((_ws: WorkspaceInfo) => {});
    const goHome = mock(() => {});

    const list = [ws("ws_rejected"), ws("ws_other")];
    recoverFromWorkspaceError(list, "ws_rejected", setActive, goHome);

    expect(setActive.mock.calls[0][0].id).toBe("ws_other");
    expect(goHome).toHaveBeenCalledTimes(1);
  });

  test("never re-selects the rejected workspace even when it is the personal one", () => {
    const setActive = mock((_ws: WorkspaceInfo) => {});
    const goHome = mock(() => {});

    const list = [ws("ws_personal", { isPersonal: true }), ws("ws_other")];
    recoverFromWorkspaceError(list, "ws_personal", setActive, goHome);

    expect(setActive.mock.calls[0][0].id).toBe("ws_other");
  });

  test("bails — no select, no navigate — when the rejected workspace is the only candidate", () => {
    const setActive = mock((_ws: WorkspaceInfo) => {});
    const goHome = mock(() => {});

    recoverFromWorkspaceError([ws("ws_rejected")], "ws_rejected", setActive, goHome);

    expect(setActive).toHaveBeenCalledTimes(0);
    expect(goHome).toHaveBeenCalledTimes(0);
  });

  test("bails on an empty workspace list", () => {
    const setActive = mock((_ws: WorkspaceInfo) => {});
    const goHome = mock(() => {});

    recoverFromWorkspaceError([], "ws_whatever", setActive, goHome);

    expect(setActive).toHaveBeenCalledTimes(0);
    expect(goHome).toHaveBeenCalledTimes(0);
  });
});
