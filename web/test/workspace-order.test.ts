// ---------------------------------------------------------------------------
// orderWorkspacesForSidebar — T013 sidebar ordering rule.
//
// Acceptance criterion (verbatim from 013-sidebar-workspace-navigator.md):
//
//   "Workspace ordering: Personal first, then shared workspaces
//    alphabetically by display name."
//
// Adversarial cases pinned:
//
//   1. Personal slot is determined by `isPersonal === true`, NOT by
//      name starting with "Personal" or by `userRole === "admin"`.
//   2. Alphabetical comparison is case-insensitive — "alpha" sorts
//      before "Beta", not after.
//   3. Tie-break on identical names is deterministic via `id`.
//   4. Missing `isPersonal` (legacy entries) is treated as shared —
//      a regression that interpreted `undefined` as truthy would
//      yank every legacy workspace into the personal slot.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";
import { orderWorkspacesForSidebar } from "../src/lib/workspace-order";

function ws(over: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: "ws_default",
    name: "Default",
    memberCount: 1,
    bundles: [],
    ...over,
  };
}

describe("orderWorkspacesForSidebar", () => {
  test("personal first, then shared workspaces alphabetically", () => {
    const out = orderWorkspacesForSidebar([
      ws({ id: "ws_helix", name: "Helix" }),
      ws({ id: "ws_acme", name: "Acme" }),
      ws({ id: "ws_user_u1", name: "Personal", isPersonal: true }),
      ws({ id: "ws_basecamp", name: "Basecamp" }),
    ]);
    expect(out.map((w) => w.id)).toEqual([
      "ws_user_u1",
      "ws_acme",
      "ws_basecamp",
      "ws_helix",
    ]);
  });

  test("case-insensitive alphabetical comparison among shared workspaces", () => {
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

  test("legacy entries without isPersonal are treated as shared", () => {
    // A regression that interpreted `undefined` as truthy would lift
    // these into the personal slot — pin the negative.
    const out = orderWorkspacesForSidebar([
      ws({ id: "ws_a", name: "A" }),
      ws({ id: "ws_user_u1", name: "My Personal", isPersonal: true }),
      ws({ id: "ws_b", name: "B" }),
    ]);
    expect(out[0]?.id).toBe("ws_user_u1");
    expect(out[1]?.id).toBe("ws_a");
    expect(out[2]?.id).toBe("ws_b");
  });

  test("does not mutate the input array", () => {
    const input: WorkspaceInfo[] = [
      ws({ id: "ws_b", name: "B" }),
      ws({ id: "ws_a", name: "A", isPersonal: true }),
    ];
    const snapshot = input.map((w) => w.id);
    orderWorkspacesForSidebar(input);
    expect(input.map((w) => w.id)).toEqual(snapshot);
  });
});
