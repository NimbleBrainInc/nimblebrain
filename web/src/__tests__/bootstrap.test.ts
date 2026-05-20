// ---------------------------------------------------------------------------
// bootstrapWorkspacesToInfo — bootstrap → WorkspaceInfo mapping
//
// Pins the load-bearing field propagation so a future contributor can't
// silently drop `userRole`. The pure-resolution test for `useScopedRole`
// already covers what *should* happen given a userRole; this test covers
// the upstream half — that the field actually arrives at the resolver.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";

import { bootstrapWorkspacesToInfo, parseWorkspaceListResponse } from "../lib/bootstrap";
import type { BootstrapResponse } from "../types";

function bootstrapWs(
  partial: Partial<BootstrapResponse["workspaces"][number]> & {
    role: "admin" | "member";
  },
): BootstrapResponse["workspaces"][number] {
  return {
    id: "ws_test",
    name: "Test",
    memberCount: 1,
    bundleCount: 0,
    isPersonal: false,
    ...partial,
  };
}

describe("bootstrapWorkspacesToInfo", () => {
  test("propagates role as userRole — admin", () => {
    const [info] = bootstrapWorkspacesToInfo([bootstrapWs({ role: "admin" })]);
    expect(info?.userRole).toBe("admin");
  });

  test("propagates role as userRole — member", () => {
    const [info] = bootstrapWorkspacesToInfo([bootstrapWs({ role: "member" })]);
    expect(info?.userRole).toBe("member");
  });

  test("preserves id, name, memberCount; bundles starts empty", () => {
    const [info] = bootstrapWorkspacesToInfo([
      bootstrapWs({ id: "ws_1", name: "Acme", memberCount: 5, role: "admin" }),
    ]);
    expect(info?.id).toBe("ws_1");
    expect(info?.name).toBe("Acme");
    expect(info?.memberCount).toBe(5);
    expect(info?.bundles).toEqual([]);
  });

  test("maps every workspace independently", () => {
    const result = bootstrapWorkspacesToInfo([
      bootstrapWs({ id: "ws_1", role: "admin" }),
      bootstrapWs({ id: "ws_2", role: "member" }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.userRole).toBe("admin");
    expect(result[1]?.userRole).toBe("member");
  });

  test("empty input → empty output", () => {
    expect(bootstrapWorkspacesToInfo([])).toEqual([]);
  });
});

describe("parseWorkspaceListResponse", () => {
  test("propagates userRole when server returns it (manage_workspaces.list shape)", () => {
    // Today's `manage_workspaces.list` server handler emits `userRole`
    // directly (workspace-mgmt-tools.ts handleList).
    const result = parseWorkspaceListResponse({
      workspaces: [{ id: "ws_1", name: "A", memberCount: 2, userRole: "admin" }],
    });
    expect(result[0]?.userRole).toBe("admin");
  });

  test("propagates role when server returns it (bootstrap shape)", () => {
    // Defense against future contract drift: if either side renames the
    // field, the other should still find it. Pinning this in a test makes
    // the contract bidirectional rather than silently fragile.
    const result = parseWorkspaceListResponse({
      workspaces: [{ id: "ws_1", name: "A", memberCount: 2, role: "member" }],
    });
    expect(result[0]?.userRole).toBe("member");
  });

  test("prefers userRole over role when both are present", () => {
    // The newer field wins — server's intent is authoritative.
    const result = parseWorkspaceListResponse({
      workspaces: [{ id: "ws_1", name: "A", memberCount: 1, role: "member", userRole: "admin" }],
    });
    expect(result[0]?.userRole).toBe("admin");
  });

  test("accepts bare array envelope", () => {
    const result = parseWorkspaceListResponse([
      { id: "ws_1", name: "A", memberCount: 1, userRole: "admin" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.userRole).toBe("admin");
  });

  test("ignores unrecognized role values rather than passing them through", () => {
    // Belt-and-suspenders: if the server starts returning "owner" or some
    // other value we haven't whitelisted, drop it rather than letting an
    // unexpected string flow into the role resolver.
    const result = parseWorkspaceListResponse({
      workspaces: [{ id: "ws_1", name: "A", memberCount: 1, userRole: "owner" }],
    });
    expect(result[0]?.userRole).toBeUndefined();
  });

  test("returns empty array for null / undefined / unrecognized envelope", () => {
    expect(parseWorkspaceListResponse(null)).toEqual([]);
    expect(parseWorkspaceListResponse(undefined)).toEqual([]);
    expect(parseWorkspaceListResponse({ unrelated: 1 })).toEqual([]);
  });

  test("filters out malformed workspace entries", () => {
    const result = parseWorkspaceListResponse([
      { id: "ws_1", name: "Good", memberCount: 1, userRole: "member" },
      null,
      "not-an-object",
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("ws_1");
  });
});
