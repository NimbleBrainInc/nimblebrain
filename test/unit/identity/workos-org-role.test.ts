/**
 * WorkOS org-role mapping + owner preservation.
 *
 * Covers `resolveOrgRole`'s configurable, case-insensitive admin-slug mapping
 * (the fix for a custom WorkOS admin role slug silently mapping to `member`)
 * and the rule that a login-time `syncLocalProfile` never downgrades a local
 * `owner` (so `owner` is a stable app-internal elevation, not clobbered by a
 * WorkOS membership change).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";
import type { OrgRole } from "../../../src/identity/types.ts";
import { UserStore } from "../../../src/identity/user.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

let workDir: string;
let userStore: UserStore;
let workspaceStore: WorkspaceStore;

const BASE_CONFIG: WorkosAuth = {
  adapter: "workos",
  clientId: "client_test",
  redirectUri: "http://localhost/callback",
  organizationId: "org_test123",
  apiKey: "sk_test_fake",
};

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-workos-role-"));
  userStore = new UserStore(workDir);
  workspaceStore = new WorkspaceStore(workDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Build a provider with the WorkOS SDK's org-membership lookup mocked.
 * `memberships` maps userId → role slug; absence means "no membership".
 */
function makeProvider(memberships: Map<string, string>, configOverride?: Partial<WorkosAuth>) {
  const provider = new WorkosIdentityProvider(
    { ...BASE_CONFIG, ...configOverride },
    userStore,
    workspaceStore,
  );
  const workos = (provider as unknown as { workos: Record<string, unknown> }).workos;
  workos.userManagement = {
    getUser: async (userId: string) => ({
      id: userId,
      email: `${userId}@test.com`,
      firstName: "Test",
      lastName: "User",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    listOrganizationMemberships: async (opts: { userId: string; organizationId: string }) => {
      const slug = memberships.get(opts.userId);
      if (!slug) return { data: [] };
      return {
        data: [
          {
            id: "om_test",
            userId: opts.userId,
            organizationId: opts.organizationId,
            role: { slug },
            status: "active",
          },
        ],
      };
    },
  };
  return provider;
}

/** Invoke the private `resolveOrgRole` (mirrors the cast in workos-provisioning.test.ts). */
function resolveOrgRole(provider: WorkosIdentityProvider, userId: string): Promise<OrgRole | null> {
  return (
    provider as unknown as { resolveOrgRole: (id: string) => Promise<OrgRole | null> }
  ).resolveOrgRole.call(provider, userId);
}

describe("WorkOS resolveOrgRole slug mapping", () => {
  it("maps the default 'admin' slug to admin", async () => {
    const p = makeProvider(new Map([["u", "admin"]]));
    expect(await resolveOrgRole(p, "u")).toBe("admin");
  });

  it("maps the default 'owner' slug to admin (owner is app-internal, never WorkOS-derived)", async () => {
    const p = makeProvider(new Map([["u", "owner"]]));
    expect(await resolveOrgRole(p, "u")).toBe("admin");
  });

  it("matches admin slugs case-insensitively", async () => {
    const p = makeProvider(new Map([["u", "Admin"]]));
    expect(await resolveOrgRole(p, "u")).toBe("admin");
  });

  it("maps an unrecognized slug to member and logs the downgrade", async () => {
    const p = makeProvider(new Map([["u", "org-admin"]]));
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      expect(await resolveOrgRole(p, "u")).toBe("member");
    } finally {
      console.warn = original;
    }
    // The silent-downgrade trap must be observable: log names the actual slug
    // and points at the config knob.
    expect(warnings.some((w) => w.includes("org-admin") && w.includes("adminRoleSlugs"))).toBe(true);
  });

  it("honors a custom admin slug via adminRoleSlugs config", async () => {
    const p = makeProvider(new Map([["u", "org-admin"]]), { adminRoleSlugs: ["org-admin"] });
    expect(await resolveOrgRole(p, "u")).toBe("admin");
  });

  it("treats an explicit adminRoleSlugs list as the full set (replaces defaults)", async () => {
    // With a custom list, the built-in 'admin' slug is no longer special — and
    // the unmatched-slug warning makes that visible in logs.
    const p = makeProvider(new Map([["u", "admin"]]), { adminRoleSlugs: ["org-admin"] });
    expect(await resolveOrgRole(p, "u")).toBe("member");
  });

  it("returns member when no organizationId is configured", async () => {
    const p = makeProvider(new Map(), { organizationId: undefined });
    expect(await resolveOrgRole(p, "u")).toBe("member");
  });

  it("returns null (deny) when the user has no org membership", async () => {
    const p = makeProvider(new Map());
    expect(await resolveOrgRole(p, "u")).toBeNull();
  });
});

describe("WorkOS syncLocalProfile owner preservation", () => {
  it("does not downgrade a local owner when WorkOS resolves a lesser role", async () => {
    await userStore.create({
      id: "user_owner",
      email: "owner@test.com",
      displayName: "Owner",
      orgRole: "owner",
    });

    const provider = makeProvider(new Map([["user_owner", "member"]]));
    const workos = (provider as unknown as { workos: Record<string, unknown> }).workos;
    (workos.userManagement as Record<string, unknown>).authenticateWithCode = async () => ({
      accessToken: "tok",
      refreshToken: "ref",
      user: { id: "user_owner", email: "owner@test.com", firstName: "Owner", lastName: "" },
    });

    await provider.exchangeCode("code");

    const profile = await userStore.get("user_owner");
    expect(profile?.orgRole).toBe("owner");
  });

  it("still syncs the WorkOS-derived role for a non-owner on login", async () => {
    await userStore.create({
      id: "user_member",
      email: "member@test.com",
      displayName: "Member",
      orgRole: "member",
    });

    const provider = makeProvider(new Map([["user_member", "admin"]]));
    const workos = (provider as unknown as { workos: Record<string, unknown> }).workos;
    (workos.userManagement as Record<string, unknown>).authenticateWithCode = async () => ({
      accessToken: "tok",
      refreshToken: "ref",
      user: { id: "user_member", email: "member@test.com", firstName: "Member", lastName: "" },
    });

    await provider.exchangeCode("code");

    const profile = await userStore.get("user_member");
    expect(profile?.orgRole).toBe("admin");
  });
});
