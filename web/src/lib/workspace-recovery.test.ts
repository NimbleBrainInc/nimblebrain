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
  return { id, name: id, memberCount: 1, connectorCount: 0, ...opts };
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
    recoverFromWorkspaceError(
      [ws("ws_00079598e311c160"), ws("ws_001c32f121060ff3")],
      "ws_00079598e311c160",
      s.setActive,
      s.goHome,
      s.restart,
    );

    expect(s.setActive.mock.calls[0][0].id).toBe("ws_001c32f121060ff3");
    expect(s.goHome).toHaveBeenCalledTimes(1);
    expect(s.restart).toHaveBeenCalledTimes(0);
  });

  test("never re-selects the rejected workspace even when it is first in the list", () => {
    // The pathological case the exclusion guards: a stale cached list where the
    // rejected (active) id is workspaces[0]. Without the exclusion this would
    // re-select the same bad id.
    const s = spies();
    recoverFromWorkspaceError(
      [ws("ws_0066a7e81df7145c"), ws("ws_005820c54ca342ad")],
      "ws_0066a7e81df7145c",
      s.setActive,
      s.goHome,
      s.restart,
    );

    expect(s.setActive.mock.calls[0][0].id).toBe("ws_005820c54ca342ad");
    expect(s.goHome).toHaveBeenCalledTimes(1);
  });

  test("restarts the shell — no select, no navigate — when the rejected workspace is the only one", () => {
    const s = spies();
    recoverFromWorkspaceError(
      [ws("ws_0066a7e81df7145c")],
      "ws_0066a7e81df7145c",
      s.setActive,
      s.goHome,
      s.restart,
    );

    expect(s.setActive).toHaveBeenCalledTimes(0);
    expect(s.goHome).toHaveBeenCalledTimes(0);
    expect(s.restart).toHaveBeenCalledTimes(1);
  });

  test("restarts the shell on an empty workspace list", () => {
    const s = spies();
    recoverFromWorkspaceError([], "ws_0087195c2f920b3c", s.setActive, s.goHome, s.restart);

    expect(s.setActive).toHaveBeenCalledTimes(0);
    expect(s.goHome).toHaveBeenCalledTimes(0);
    expect(s.restart).toHaveBeenCalledTimes(1);
  });
});
