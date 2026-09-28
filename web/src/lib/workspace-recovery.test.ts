// ---------------------------------------------------------------------------
// recoverFromWorkspaceError — workspace_error recovery logic
//
// The branching half of the workspace_error net (App.tsx wires this to the
// onWorkspaceError hook). Tested directly with injected side effects so the
// fallback selection, the exclusion of the rejected workspace, and the shell
// restart when nothing remains are all covered without rendering the shell.
// ---------------------------------------------------------------------------

import { describe, expect, mock, test } from "bun:test";
import type { WorkspaceInfo } from "../context/WorkspaceContext";
import { recoverFromWorkspaceError } from "./workspace-recovery";

function ws(id: string, opts: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { id, name: id, memberCount: 1, connectors: [], ...opts };
}

function spies() {
  return {
    setActive: mock((_ws: WorkspaceInfo) => {}),
    goHome: mock(() => {}),
    restart: mock(() => {}),
  };
}

describe("recoverFromWorkspaceError", () => {
  test("falls back to the first non-rejected workspace", () => {
    const s = spies();
    recoverFromWorkspaceError([ws("ws_a"), ws("ws_b")], "ws_a", s.setActive, s.goHome, s.restart);

    expect(s.setActive.mock.calls[0][0].id).toBe("ws_b");
    expect(s.goHome).toHaveBeenCalledTimes(1);
    expect(s.restart).toHaveBeenCalledTimes(0);
  });

  test("never re-selects the rejected workspace even when it is first in the list", () => {
    // The pathological case the exclusion guards: a stale cached list where the
    // rejected (active) id is workspaces[0]. Without the exclusion this would
    // re-select the same bad id.
    const s = spies();
    recoverFromWorkspaceError(
      [ws("ws_rejected"), ws("ws_other")],
      "ws_rejected",
      s.setActive,
      s.goHome,
      s.restart,
    );

    expect(s.setActive.mock.calls[0][0].id).toBe("ws_other");
    expect(s.goHome).toHaveBeenCalledTimes(1);
  });

  test("restarts the shell — no select, no navigate — when the rejected workspace is the only one", () => {
    const s = spies();
    recoverFromWorkspaceError([ws("ws_rejected")], "ws_rejected", s.setActive, s.goHome, s.restart);

    expect(s.setActive).toHaveBeenCalledTimes(0);
    expect(s.goHome).toHaveBeenCalledTimes(0);
    expect(s.restart).toHaveBeenCalledTimes(1);
  });

  test("restarts the shell on an empty workspace list", () => {
    const s = spies();
    recoverFromWorkspaceError([], "ws_whatever", s.setActive, s.goHome, s.restart);

    expect(s.setActive).toHaveBeenCalledTimes(0);
    expect(s.goHome).toHaveBeenCalledTimes(0);
    expect(s.restart).toHaveBeenCalledTimes(1);
  });
});
