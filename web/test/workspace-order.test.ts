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
    id: "ws_00299f642c763af7",
    name: "Default",
    memberCount: 1,
    connectorCount: 0,
    ...over,
  };
}

describe("orderWorkspacesForSidebar", () => {
  test("orders every workspace alphabetically by name", () => {
    const out = orderWorkspacesForSidebar([
      ws({ id: "ws_003eba8844413cd9", name: "Helix" }),
      ws({ id: "ws_000f7ed6658f9d30", name: "Acme" }),
      ws({ id: "ws_00488fa17f87e9a3", name: "Mat's workspace", userRole: "admin" }),
      ws({ id: "ws_001e036c5def1252", name: "Basecamp" }),
    ]);
    expect(out.map((w) => w.id)).toEqual(["ws_000f7ed6658f9d30", "ws_001e036c5def1252", "ws_003eba8844413cd9", "ws_00488fa17f87e9a3"]);
  });

  test("case-insensitive alphabetical comparison", () => {
    const out = orderWorkspacesForSidebar([
      ws({ id: "ws_001c32f121060ff3", name: "beta" }),
      ws({ id: "ws_00079598e311c160", name: "Alpha" }),
    ]);
    expect(out.map((w) => w.id)).toEqual(["ws_00079598e311c160", "ws_001c32f121060ff3"]);
  });

  test("tie-break on identical names is deterministic via id", () => {
    const out = orderWorkspacesForSidebar([
      ws({ id: "ws_008ddb38b76a2208", name: "Helix" }),
      ws({ id: "ws_000ae701affede10", name: "Helix" }),
    ]);
    expect(out.map((w) => w.id)).toEqual(["ws_000ae701affede10", "ws_008ddb38b76a2208"]);
  });

  test("does not mutate the input array", () => {
    const input: WorkspaceInfo[] = [ws({ id: "ws_001c32f121060ff3", name: "B" }), ws({ id: "ws_00079598e311c160", name: "A" })];
    const snapshot = input.map((w) => w.id);
    orderWorkspacesForSidebar(input);
    expect(input.map((w) => w.id)).toEqual(snapshot);
  });

  test("pinned workspaces lead, each group alphabetical", () => {
    const out = orderWorkspacesForSidebar(
      [
        ws({ id: "ws_003eba8844413cd9", name: "Helix" }),
        ws({ id: "ws_000f7ed6658f9d30", name: "Acme" }),
        ws({ id: "ws_008cdfc2b7fba196", name: "Zeta" }),
        ws({ id: "ws_001e036c5def1252", name: "Basecamp" }),
      ],
      new Set(["ws_008cdfc2b7fba196", "ws_001e036c5def1252", "ws_003bdf4cf2ed3a6e"]),
    );
    expect(out.map((w) => w.id)).toEqual(["ws_001e036c5def1252", "ws_008cdfc2b7fba196", "ws_000f7ed6658f9d30", "ws_003eba8844413cd9"]);
  });
});
