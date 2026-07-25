// ---------------------------------------------------------------------------
// useScopedRole — pure resolution semantics
//
// The hook itself is a trivial reactive wrapper around `resolveScopedRole`,
// which is the load-bearing piece for permission-gating UX. Pinning its
// behavior under every combination of org role × workspace membership.
//
// Note: this gates UI affordances only. The backend is the security
// boundary — every workspace/org write tool independently re-checks roles.
// These tests verify the *visibility* contract, not security.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";

import type { SessionInfo } from "../context/SessionContext";
import type { WorkspaceInfo } from "../context/WorkspaceContext";
import { canWriteWorkspace, resolveScopedRole, roleAtLeast } from "../hooks/useScopedRole";

function session(orgRole?: string, authenticated = true): SessionInfo {
  return {
    authenticated,
    user: { id: "u1", email: "u@ex.com", displayName: "U", orgRole },
  };
}

function workspace(userRole?: "admin" | "member"): WorkspaceInfo {
  return { id: "ws_demo", name: "Demo", memberCount: 1, bundles: [], userRole };
}

describe("resolveScopedRole — org-level overrides", () => {
  test("org owner is org_owner regardless of workspace membership", () => {
    expect(resolveScopedRole(session("owner"), null)).toBe("org_owner");
    expect(resolveScopedRole(session("owner"), workspace())).toBe("org_owner");
    expect(resolveScopedRole(session("owner"), workspace("member"))).toBe("org_owner");
  });

  test("org admin is org_admin regardless of workspace membership", () => {
    expect(resolveScopedRole(session("admin"), null)).toBe("org_admin");
    expect(resolveScopedRole(session("admin"), workspace("member"))).toBe("org_admin");
  });
});

describe("resolveScopedRole — workspace-level fallback", () => {
  test("workspace admin (org member) is ws_admin", () => {
    expect(resolveScopedRole(session("member"), workspace("admin"))).toBe("ws_admin");
  });

  test("workspace member (org member) is ws_member", () => {
    expect(resolveScopedRole(session("member"), workspace("member"))).toBe("ws_member");
  });

  test("authenticated org member with no workspace membership is none", () => {
    expect(resolveScopedRole(session("member"), null)).toBe("none");
    expect(resolveScopedRole(session("member"), workspace())).toBe("none");
  });
});

describe("resolveScopedRole — unauthenticated", () => {
  test("null session returns none", () => {
    expect(resolveScopedRole(null, workspace("admin"))).toBe("none");
  });

  test("authenticated:false returns none even with workspace role", () => {
    expect(resolveScopedRole(session(undefined, false), workspace("admin"))).toBe("none");
  });
});

describe("roleAtLeast", () => {
  test("each role meets its own threshold", () => {
    for (const role of ["none", "ws_member", "ws_admin", "org_admin", "org_owner"] as const) {
      expect(roleAtLeast(role, role)).toBe(true);
    }
  });

  test("higher roles meet lower thresholds (org owners pass ws_admin gate)", () => {
    expect(roleAtLeast("org_owner", "ws_admin")).toBe(true);
    expect(roleAtLeast("org_admin", "ws_admin")).toBe(true);
    expect(roleAtLeast("ws_admin", "ws_member")).toBe(true);
  });

  test("lower roles don't meet higher thresholds (ws_member doesn't pass ws_admin)", () => {
    expect(roleAtLeast("ws_member", "ws_admin")).toBe(false);
    expect(roleAtLeast("ws_admin", "org_admin")).toBe(false);
    expect(roleAtLeast("none", "ws_member")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canWriteWorkspace — the write gate, which is NOT the role ordering
//
// `resolveScopedRole` escalates org admins to `org_admin`, so they clear a
// `roleAtLeast(…, "ws_admin")` check for every workspace. That is right for
// reach (nav, route guards, read gates) and wrong for writes: the server's
// `canWriteWorkspaceScoped` requires membership with `role === "admin"` and
// never consults `orgRole`. These pin the difference.
// ---------------------------------------------------------------------------

describe("canWriteWorkspace", () => {
  test("a workspace admin may write", () => {
    expect(canWriteWorkspace(workspace("admin"))).toBe(true);
  });

  test("a workspace member may not", () => {
    expect(canWriteWorkspace(workspace("member"))).toBe(false);
  });

  test("a non-member may not", () => {
    // `userRole: undefined` is the server's "Not a member" denial.
    expect(canWriteWorkspace(workspace())).toBe(false);
    expect(canWriteWorkspace(null)).toBe(false);
  });

  test("org role grants no bypass — the whole point of this helper", () => {
    // The regression this exists to prevent: an org admin who is only a
    // member of the workspace clears the role ordering but must not clear
    // the write gate, because `canWriteWorkspaceScoped` would refuse them.
    const orgAdminWhoIsOnlyAMember = session("admin");
    const ws = workspace("member");

    // Reach says yes...
    expect(roleAtLeast(resolveScopedRole(orgAdminWhoIsOnlyAMember, ws), "ws_admin")).toBe(true);
    // ...and write says no. If these ever agree, one of them is wrong.
    expect(canWriteWorkspace(ws)).toBe(false);
  });

  test("org owner gets no bypass either", () => {
    expect(roleAtLeast(resolveScopedRole(session("owner"), workspace("member")), "ws_admin")).toBe(
      true,
    );
    expect(canWriteWorkspace(workspace("member"))).toBe(false);
  });
});
