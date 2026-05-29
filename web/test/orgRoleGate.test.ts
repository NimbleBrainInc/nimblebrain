/**
 * Regression test for the org-admin role gate that mounts `/org/skills`.
 *
 * Phase 1 of the skills-surface spec adds a new org-admin route at
 * `/org/skills` gated by the existing `RouteGuard role="org_admin"`
 * pattern. The gate is two layers deep:
 *
 *   1. Pure resolution from session.user.orgRole → ScopedRole
 *      (`resolveScopedRole`)
 *   2. Pure comparison against the route's required minimum
 *      (`roleAtLeast`)
 *
 * Both are exported for testing. This test pins the contract so a future
 * refactor of the role plumbing cannot silently break the org-admin gate
 * for the new skills surface (or the existing /org/* tabs).
 */

import { describe, expect, it } from "bun:test";
import type { SessionInfo } from "../src/context/SessionContext";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";
import { resolveScopedRole, roleAtLeast } from "../src/hooks/useScopedRole";

function makeSession(orgRole: "owner" | "admin" | "member" | undefined): SessionInfo {
  return {
    authenticated: true,
    user: orgRole
      ? {
          id: "u_test",
          email: "u@example.com",
          displayName: "Test User",
          orgRole,
          preferences: { timezone: "UTC", locale: "en-US", theme: "system" },
        }
      : null,
  } as SessionInfo;
}

describe("org-admin gate for /org/skills (and every other /org/* route)", () => {
  it("resolves org_owner from session.user.orgRole=owner regardless of workspace context", () => {
    const role = resolveScopedRole(makeSession("owner"), null);
    expect(role).toBe("org_owner");
  });

  it("resolves org_admin from session.user.orgRole=admin regardless of workspace context", () => {
    const role = resolveScopedRole(makeSession("admin"), null);
    expect(role).toBe("org_admin");
  });

  it("never resolves to org_admin from workspace-admin alone", () => {
    // Workspace admins must not bypass the org-admin gate. Org-tier writes
    // (org skills, org users, org registries) are reserved to identities
    // the IDP marked admin/owner, not to any workspace's admin.
    const session = makeSession("member");
    const wsAdmin: Partial<WorkspaceInfo> = { id: "ws_x", userRole: "admin" };
    const role = resolveScopedRole(session, wsAdmin as WorkspaceInfo);
    expect(role).toBe("ws_admin");
    expect(roleAtLeast(role, "org_admin")).toBe(false);
  });

  it("rejects ws_member against org_admin minimum (Phase 1 /org/skills surface)", () => {
    const session = makeSession("member");
    const wsMember: Partial<WorkspaceInfo> = { id: "ws_x", userRole: "member" };
    const role = resolveScopedRole(session, wsMember as WorkspaceInfo);
    expect(role).toBe("ws_member");
    expect(roleAtLeast(role, "org_admin")).toBe(false);
  });

  it("rejects 'none' (unauthenticated) against org_admin minimum", () => {
    const role = resolveScopedRole({ authenticated: false, user: null } as SessionInfo, null);
    expect(role).toBe("none");
    expect(roleAtLeast(role, "org_admin")).toBe(false);
  });

  it("admits org_admin and org_owner against the org_admin minimum", () => {
    expect(roleAtLeast("org_admin", "org_admin")).toBe(true);
    expect(roleAtLeast("org_owner", "org_admin")).toBe(true);
  });
});
