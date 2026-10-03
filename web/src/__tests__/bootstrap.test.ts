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
    id: "ws_0076759dbbe19fcc",
    name: "Test",
    memberCount: 1,
    connectorCount: 0,
    mcpUrl: "https://nb.example.test/mcp/ws_0076759dbbe19fcc",
    unread: 0,
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

  test("preserves id, name, memberCount, connectorCount", () => {
    const [info] = bootstrapWorkspacesToInfo([
      bootstrapWs({
        id: "ws_0002ee92e8791c13",
        name: "Acme",
        memberCount: 5,
        connectorCount: 3,
        role: "admin",
      }),
    ]);
    expect(info?.id).toBe("ws_0002ee92e8791c13");
    expect(info?.name).toBe("Acme");
    expect(info?.memberCount).toBe(5);
    expect(info?.connectorCount).toBe(3);
  });

  test("maps every workspace independently", () => {
    const result = bootstrapWorkspacesToInfo([
      bootstrapWs({ id: "ws_0002ee92e8791c13", role: "admin" }),
      bootstrapWs({ id: "ws_000557aaec30828a", role: "member" }),
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]?.userRole).toBe("admin");
    expect(result[1]?.userRole).toBe("member");
  });

  test("empty input → empty output", () => {
    expect(bootstrapWorkspacesToInfo([])).toEqual([]);
  });
});
