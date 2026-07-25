// ---------------------------------------------------------------------------
// memberRoleFor — the argument to WorkspaceDetailPage's write gate.
//
// The rule itself (`canWriteWorkspace`) is pinned in useScopedRole.test.ts.
// Pinning the rule does not pin the call: this page is the one site where the
// bug was found written longhand (an `isOrgAdmin ||` bypass), and it reaches
// the rule through a lookup no test covered. These pin the lookup.
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { canWriteWorkspace } from "../hooks/useScopedRole";
import { memberRoleFor } from "../pages/settings/WorkspaceDetailPage";

const MEMBERS = [
  { userId: "u_admin", role: "admin" as const },
  { userId: "u_member", role: "member" as const },
];

describe("memberRoleFor", () => {
  test("finds an admin member's role", () => {
    expect(memberRoleFor(MEMBERS, "u_admin")).toBe("admin");
  });

  test("finds a plain member's role", () => {
    expect(memberRoleFor(MEMBERS, "u_member")).toBe("member");
  });

  test("a non-member has no role — including an org admin viewing someone else's workspace", () => {
    expect(memberRoleFor(MEMBERS, "u_org_admin_not_in_this_workspace")).toBeUndefined();
  });

  test("an unresolved session has no role, and does not match a blank record", () => {
    // `currentUserId` is `session?.user?.id` and can be undefined mid-load.
    // Without the guard, `find` would match a member record with no userId.
    expect(memberRoleFor(MEMBERS, undefined)).toBeUndefined();
    const withBlank = [
      ...MEMBERS,
      { userId: undefined as unknown as string, role: "admin" as const },
    ];
    expect(memberRoleFor(withBlank, undefined)).toBeUndefined();
  });

  test("empty roster denies", () => {
    expect(memberRoleFor([], "u_admin")).toBeUndefined();
  });
});

describe("memberRoleFor → canWriteWorkspace — the composed gate", () => {
  // What the page actually evaluates. Both directions, so neither a
  // permanently-true nor a permanently-false gate passes.
  test("only a workspace admin may manage members", () => {
    expect(canWriteWorkspace(memberRoleFor(MEMBERS, "u_admin"))).toBe(true);
    expect(canWriteWorkspace(memberRoleFor(MEMBERS, "u_member"))).toBe(false);
    expect(canWriteWorkspace(memberRoleFor(MEMBERS, "u_outsider"))).toBe(false);
    expect(canWriteWorkspace(memberRoleFor(MEMBERS, undefined))).toBe(false);
  });
});
