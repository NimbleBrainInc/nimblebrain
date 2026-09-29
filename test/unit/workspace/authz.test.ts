import { describe, expect, test } from "bun:test";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import type { OrgRole } from "../../../src/identity/types.ts";
import {
  canManageWorkspaceMembers,
  canWriteWorkspaceScoped,
} from "../../../src/workspace/authz.ts";
import type { Workspace, WorkspaceRole } from "../../../src/workspace/types.ts";

function identity(id: string, orgRole: OrgRole = "member"): UserIdentity {
  return {
    id,
    email: `${id}@example.com`,
    displayName: id,
    orgRole,
    preferences: {},
  };
}

function workspace(members: Array<{ userId: string; role: WorkspaceRole }>): Workspace {
  return {
    id: "ws-acme",
    name: "Acme",
    members,
    connectors: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("canWriteWorkspaceScoped", () => {
  test("allows a workspace admin member", () => {
    const ws = workspace([{ userId: "u1", role: "admin" }]);
    expect(canWriteWorkspaceScoped(identity("u1"), ws)).toEqual({
      allowed: true,
    });
  });

  test("denies a non-admin member and names the admin requirement", () => {
    const ws = workspace([{ userId: "u1", role: "member" }]);
    const decision = canWriteWorkspaceScoped(identity("u1"), ws);

    expect(decision.allowed).toBe(false);
    if (decision.allowed !== false) throw new Error("expected denial");
    expect(decision.reason).toContain("admin");
    expect(decision.reason).toContain("ws-acme");
  });

  test("denies a non-member even when their org role is owner", () => {
    const ws = workspace([{ userId: "owner-member", role: "admin" }]);
    const decision = canWriteWorkspaceScoped(identity("outsider", "owner"), ws);

    expect(decision.allowed).toBe(false);
    if (decision.allowed !== false) throw new Error("expected denial");
    expect(decision.reason).toContain("Not a member");
    expect(decision.reason).toContain("ws-acme");
  });

  test("denies a non-member even when their org role is admin", () => {
    const ws = workspace([{ userId: "someone-else", role: "admin" }]);
    const decision = canWriteWorkspaceScoped(identity("outsider", "admin"), ws);

    expect(decision.allowed).toBe(false);
    if (decision.allowed !== false) throw new Error("expected denial");
    expect(decision.reason).toContain("Not a member");
  });

  test("denies a null identity", () => {
    const ws = workspace([{ userId: "u1", role: "admin" }]);
    expect(canWriteWorkspaceScoped(null, ws).allowed).toBe(false);
  });

  test("denies an undefined identity", () => {
    const ws = workspace([{ userId: "u1", role: "admin" }]);
    expect(canWriteWorkspaceScoped(undefined, ws).allowed).toBe(false);
  });

  test("denies when the workspace is null", () => {
    expect(canWriteWorkspaceScoped(identity("u1", "owner"), null).allowed).toBe(false);
  });

  test("denies when the workspace is undefined", () => {
    expect(canWriteWorkspaceScoped(identity("u1", "owner"), undefined).allowed).toBe(false);
  });

  test("fails closed when members is not an array (undefined)", () => {
    // Malformed workspace record: `members` missing. Must deny rather
    // than throw — fail-closed posture for an authorization helper.
    const ws = { id: "ws-acme", name: "Acme" } as unknown as Workspace;
    const decision = canWriteWorkspaceScoped(identity("u1", "owner"), ws);

    expect(decision.allowed).toBe(false);
    if (decision.allowed !== false) throw new Error("expected denial");
    expect(decision.reason).toContain("Not a member");
  });
});

describe("canManageWorkspaceMembers", () => {
  test("allows an org admin or owner who is not a member", () => {
    const ws = workspace([{ userId: "u1", role: "admin" }]);
    expect(canManageWorkspaceMembers(identity("org", "admin"), ws)).toEqual({ allowed: true });
    expect(canManageWorkspaceMembers(identity("org", "owner"), ws)).toEqual({ allowed: true });
  });

  test("allows a workspace admin member with no org role", () => {
    const ws = workspace([{ userId: "u1", role: "admin" }]);
    expect(canManageWorkspaceMembers(identity("u1"), ws)).toEqual({ allowed: true });
  });

  test("denies a plain member and a non-member without an org admin role", () => {
    const ws = workspace([{ userId: "u1", role: "member" }]);
    expect(canManageWorkspaceMembers(identity("u1"), ws).allowed).toBe(false);
    expect(canManageWorkspaceMembers(identity("u2"), ws).allowed).toBe(false);
  });

  test("denies an org admin when the workspace does not exist, and a missing identity", () => {
    expect(canManageWorkspaceMembers(identity("org", "admin"), null).allowed).toBe(false);
    expect(canManageWorkspaceMembers(null, workspace([])).allowed).toBe(false);
  });

  test("leaves content writes strict: the same org admin is refused by canWriteWorkspaceScoped", () => {
    const ws = workspace([{ userId: "u1", role: "admin" }]);
    expect(canWriteWorkspaceScoped(identity("org", "admin"), ws).allowed).toBe(false);
  });
});
