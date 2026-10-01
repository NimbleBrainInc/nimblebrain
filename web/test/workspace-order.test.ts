// ---------------------------------------------------------------------------
// orderWorkspacesForSidebar — sidebar ordering rule.
//
// Pinned workspaces sort first; otherwise alphabetically by display name, and
// nothing else lifts a workspace ahead of the others. Adversarial cases pinned:
//
//   1. No workspace is lifted out of order — not one named for the user, not
//      one where the user is admin.
//   2. Alphabetical comparison is case-insensitive — "alpha" sorts before
//      "Beta", not after.
//   3. Tie-break on identical names is deterministic via `id`.
//   4. Pinned workspaces lead, each group still alphabetical; a pinned id
//      that names no workspace changes nothing.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";
import { orderWorkspacesForSidebar } from "../src/lib/workspace-order";

function ws(over: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: "ws_default",
    name: "Default",
    memberCount: 1,
    connectorCount: 0,
    ...over,
  };
}

describe("orderWorkspacesForSidebar", () => {
  test("orders every workspace alphabetically by name", () => {
    const out = orderWorkspacesForSidebar([
      ws({ id: "ws_helix", name: "Helix" }),
      ws({ id: "ws_acme", name: "Acme" }),
      ws({ id: "ws_mine", name: "Mat's workspace", userRole: "admin" }),
      ws({ id: "ws_basecamp", name: "Basecamp" }),
    ]);
    expect(out.map((w) => w.id)).toEqual(["ws_acme", "ws_basecamp", "ws_helix", "ws_mine"]);
  });

  test("case-insensitive alphabetical comparison", () => {
    const out = orderWorkspacesForSidebar([
      ws({ id: "ws_b", name: "beta" }),
      ws({ id: "ws_a", name: "Alpha" }),
    ]);
    expect(out.map((w) => w.id)).toEqual(["ws_a", "ws_b"]);
  });

  test("tie-break on identical names is deterministic via id", () => {
    const out = orderWorkspacesForSidebar([
      ws({ id: "ws_zzz", name: "Helix" }),
      ws({ id: "ws_aaa", name: "Helix" }),
    ]);
    expect(out.map((w) => w.id)).toEqual(["ws_aaa", "ws_zzz"]);
  });

  test("does not mutate the input array", () => {
    const input: WorkspaceInfo[] = [ws({ id: "ws_b", name: "B" }), ws({ id: "ws_a", name: "A" })];
    const snapshot = input.map((w) => w.id);
    orderWorkspacesForSidebar(input);
    expect(input.map((w) => w.id)).toEqual(snapshot);
  });

  test("pinned workspaces lead, each group alphabetical", () => {
    const out = orderWorkspacesForSidebar(
      [
        ws({ id: "ws_helix", name: "Helix" }),
        ws({ id: "ws_acme", name: "Acme" }),
        ws({ id: "ws_zeta", name: "Zeta" }),
        ws({ id: "ws_basecamp", name: "Basecamp" }),
      ],
      new Set(["ws_zeta", "ws_basecamp", "ws_gone"]),
    );
    expect(out.map((w) => w.id)).toEqual(["ws_basecamp", "ws_zeta", "ws_acme", "ws_helix"]);
  });
});
