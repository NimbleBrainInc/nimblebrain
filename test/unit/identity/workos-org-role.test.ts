/**
 * WorkOS org-role mapping and sync.
 *
 * Covers `resolveOrgRole`'s configurable, case-insensitive admin-slug mapping
 * (the fix for a custom WorkOS admin role slug silently mapping to `member`),
 * including WorkOS's own `owner` slug mapping to app `admin`, and the rule
 * that a login-time `syncLocalProfile` writes the WorkOS-derived role.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";
import type { OrgRole } from "../../../src/identity/types.ts";
import { UserStore } from "../../../src/identity/user.ts";
import { log } from "../../../src/observability/log.ts";

let workDir: string;
let userStore: UserStore;

const BASE_CONFIG: WorkosAuth = {
  adapter: "workos",
  clientId: "client_test",
  organizationId: "org_test123",
  apiKey: "sk_test_fake",
};

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-workos-role-"));
  userStore = new UserStore(workDir);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Build a provider with the WorkOS SDK's org-membership lookup mocked.
 * `memberships` maps userId → role slug; absence means "no membership".
 */
function makeProvider(memberships: Map<string, string>, configOverride?: Partial<WorkosAuth>) {
  const provider = new WorkosIdentityProvider({ ...BASE_CONFIG, ...configOverride }, userStore);
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

/** Invoke the private `resolveUser` to inspect the live session identity it builds. */
function resolveUser(
  provider: WorkosIdentityProvider,
  userId: string,
): Promise<UserIdentity | null> {
  return (
    provider as unknown as { resolveUser: (id: string) => Promise<UserIdentity | null> }
  ).resolveUser.call(provider, userId);
}

describe("WorkOS resolveOrgRole slug mapping", () => {
  it("maps the default 'admin' slug to admin", async () => {
    const p = makeProvider(new Map([["u", "admin"]]));
    expect(await resolveOrgRole(p, "u")).toBe("admin");
  });

  it("maps WorkOS's default 'owner' slug to admin, the top app role", async () => {
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
    const warnSpy = spyOn(log, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      expect(await resolveOrgRole(p, "u")).toBe("member");
    } finally {
      warnSpy.mockRestore();
    }
    // The silent-downgrade trap must be observable: log names the actual slug
    // and points at the config knob.
    expect(warnings.some((w) => w.includes("org-admin") && w.includes("adminRoleSlugs"))).toBe(
      true,
    );
  });

  it("warns at most once per unmatched slug per process", async () => {
    const p = makeProvider(
      new Map([
        ["a", "viewer"],
        ["b", "viewer"],
      ]),
    );
    let warnCount = 0;
    const warnSpy = spyOn(log, "warn").mockImplementation(() => {
      warnCount++;
    });
    try {
      // Two logins carrying the same non-admin slug — only the first should warn.
      expect(await resolveOrgRole(p, "a")).toBe("member");
      expect(await resolveOrgRole(p, "b")).toBe("member");
    } finally {
      warnSpy.mockRestore();
    }
    expect(warnCount).toBe(1);
  });

  it("falls back to the defaults when adminRoleSlugs is blank-only (never an empty set)", async () => {
    // Unreachable via config (instance.ts rejects it) but a latent footgun for
    // direct construction — the normalized set must never be empty.
    const p = makeProvider(new Map([["u", "admin"]]), { adminRoleSlugs: ["  "] });
    expect(await resolveOrgRole(p, "u")).toBe("admin");
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

  it("refuses to construct with an empty or whitespace organizationId", () => {
    for (const organizationId of ["", "   "]) {
      expect(() => makeProvider(new Map(), { organizationId })).toThrow(
        "'organizationId' must not be empty",
      );
    }
  });

  it("returns null (deny) when the user has no org membership", async () => {
    const p = makeProvider(new Map());
    expect(await resolveOrgRole(p, "u")).toBeNull();
  });
});

describe("WorkOS syncLocalProfile role sync", () => {
  it("downgrades a local admin to the role WorkOS resolves, in the store and the session", async () => {
    await userStore.create({
      id: "user_admin",
      email: "user_admin@test.com",
      displayName: "Admin",
      orgRole: "admin",
    });

    const provider = makeProvider(new Map([["user_admin", "member"]]));
    const identity = await resolveUser(provider, "user_admin");

    expect(identity?.orgRole).toBe("member");
    expect((await userStore.get("user_admin"))?.orgRole).toBe("member");
  });

  it("stores a WorkOS owner-slug user as admin, never as owner", async () => {
    const provider = makeProvider(new Map([["user_wo", "owner"]]));
    const identity = await resolveUser(provider, "user_wo");

    expect(identity?.orgRole).toBe("admin");
    expect((await userStore.get("user_wo"))?.orgRole).toBe("admin");
  });

  it("syncs the WorkOS-derived role on login", async () => {
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
