// ---------------------------------------------------------------------------
// bootstrapWorkspacesToInfo — bootstrap → WorkspaceInfo mapping
//
// Pins the load-bearing field propagation so a future contributor can't
// silently drop `userRole`. The pure-resolution test for `useScopedRole`
// already covers what *should* happen given a userRole; this test covers
// the upstream half — that the field actually arrives at the resolver.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";

import { bootstrapWorkspacesToInfo } from "../lib/bootstrap";
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
