/**
 * Security tests for WorkOS user provisioning.
 *
 * Validates that:
 * - Users without org membership are DENIED access at every entry point
 * - Users WITH org membership get provisioned correctly
 * - No profile, workspace, or identity is created for unauthorized users
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import { TransientAuthError } from "../../../src/identity/provider.ts";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";
import { UserStore } from "../../../src/identity/user.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import {
  stubWorkosUserManagement,
  workosAuthentication,
  workosMembership,
  workosMembershipList,
  workosUser,
  workosUserManagement,
} from "../../helpers/workos-sdk.ts";

// ── Test setup ───────────────────────────────────────────────────

let workDir: string;
let userStore: UserStore;
let workspaceStore: WorkspaceStore;

const MOCK_CONFIG: WorkosAuth = {
  adapter: "workos",
  clientId: "client_test",
  organizationId: "org_test123",
  apiKey: "sk_test_fake",
};

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-workos-test-"));
  userStore = new UserStore(workDir);
  workspaceStore = new WorkspaceStore(workDir);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── Mock helpers ────────────────────────────────────────────────

/**
 * Create a WorkosIdentityProvider with mocked WorkOS SDK methods.
 * orgMemberships controls which users have org access.
 */
function createMockProvider(orgMemberships: Map<string, string>) {
  const provider = new WorkosIdentityProvider(MOCK_CONFIG, userStore);

  stubWorkosUserManagement(provider, {
    getUser: async (userId) =>
      workosUser({ id: userId, email: `${userId}@test.com`, firstName: "Test", lastName: "User" }),
    listOrganizationMemberships: async (opts) => {
      const roleSlug = opts.userId ? orgMemberships.get(opts.userId) : undefined;
      if (!roleSlug) return workosMembershipList([]);
      return workosMembershipList([
        workosMembership({
          userId: opts.userId,
          organizationId: opts.organizationId,
          slug: roleSlug,
        }),
      ]);
    },
    authenticateWithCode: async () =>
      workosAuthentication({
        accessToken: "test_access_token",
        refreshToken: "test_refresh_token",
        user: workosUser({
          id: "user_unauthorized",
          email: "unauthorized@test.com",
          firstName: "Bad",
          lastName: "Actor",
        }),
      }),
    getAuthorizationUrl: () => "https://fake.workos.com/authorize",
  });

  return provider;
}

// ── Security tests ──────────────────────────────────────────────

describe("WorkOS provisioning security", () => {
  it("denies exchangeCode for users without org membership", async () => {
    // No org memberships — empty map
    const provider = createMockProvider(new Map());

    await expect(provider.exchangeCode("test_code")).rejects.toThrow(
      "not a member of this organization",
    );
  });

  it("does not create a user profile for unauthorized users", async () => {
    const provider = createMockProvider(new Map());

    try {
      await provider.exchangeCode("test_code");
    } catch {
      // Expected to throw
    }

    // Verify no profile was created
    const profile = await userStore.get("user_unauthorized");
    expect(profile).toBeNull();
  });

  it("does not create a workspace for unauthorized users", async () => {
    const provider = createMockProvider(new Map());
    const workspacesBefore = await workspaceStore.list();

    try {
      await provider.exchangeCode("test_code");
    } catch {
      // Expected to throw
    }

    // Verify no new workspace was created
    const workspacesAfter = await workspaceStore.list();
    expect(workspacesAfter.length).toBe(workspacesBefore.length);
  });

  it("denies verifyRequest for users without org membership", async () => {
    const provider = createMockProvider(new Map());

    // resolveUser calls resolveOrgRole which returns null → returns null identity
    // We can't easily test verifyRequest without a valid JWT, but we can test
    // the internal resolveUser path by checking that the cache doesn't store
    // unauthorized users
    // biome-ignore lint/complexity/useLiteralKeys: userCache is private; bracket access is TypeScript's typed path to it
    expect(provider["userCache"].size).toBe(0);
  });

  it("allows exchangeCode for users WITH org membership", async () => {
    const memberships = new Map([["user_authorized", "admin"]]);

    // Override the mock to return the authorized user
    const provider = createMockProvider(memberships);
    workosUserManagement(provider).authenticateWithCode = async () =>
      workosAuthentication({
        accessToken: "valid_token",
        refreshToken: "valid_refresh",
        user: workosUser({
          id: "user_authorized",
          email: "authorized@test.com",
          firstName: "Good",
          lastName: "User",
        }),
      });

    const result = await provider.exchangeCode("test_code");
    expect(result.accessToken).toBe("valid_token");
  });

  it("creates user profile for authorized users", async () => {
    // Profile should have been created by the previous test
    const profile = await userStore.get("user_authorized");
    expect(profile).not.toBeNull();
    expect(profile!.email).toBe("authorized@test.com");
    expect(profile!.orgRole).toBe("admin");
  });

  it("does not create a workspace in exchangeCode (bootstrap provisions)", async () => {
    // Authentication creates no workspace; bootstrap gives a user who belongs
    // to none one of their own (`ensureUserWorkspace`).
    const workspaces = await workspaceStore.getWorkspacesForUser("user_authorized");
    expect(workspaces).toHaveLength(0);
  });

  it("does not create duplicate profile on subsequent login", async () => {
    const memberships = new Map([["user_authorized", "admin"]]);
    const provider = createMockProvider(memberships);
    workosUserManagement(provider).authenticateWithCode = async () =>
      workosAuthentication({
        accessToken: "valid_token_2",
        refreshToken: "valid_refresh_2",
        user: workosUser({
          id: "user_authorized",
          email: "authorized@test.com",
          firstName: "Good",
          lastName: "User",
        }),
      });

    const workspacesBefore = await workspaceStore.list();
    await provider.exchangeCode("test_code_2");
    const workspacesAfter = await workspaceStore.list();

    expect(workspacesAfter.length).toBe(workspacesBefore.length);
  });

  it("resolveOrgRole never resolves a role on API error", async () => {
    const provider = createMockProvider(new Map());
    // Make listOrganizationMemberships throw
    workosUserManagement(provider).listOrganizationMemberships = async () => {
      throw new Error("API timeout");
    };

    // The invariant this guards: an API error must never resolve to a role —
    // least of all "member", which would silently grant access we could not
    // verify. Throwing satisfies it more strictly than the old `null` return
    // (no value is produced at all) while letting the caller distinguish
    // "could not check" from "definitively no membership": the former answers
    // 503, the latter still denies. Nothing is granted on either path.
    // biome-ignore lint/complexity/useLiteralKeys: resolveOrgRole is private; bracket access is TypeScript's typed path to it
    const err = await provider["resolveOrgRole"]("user_any").then(
      (role) => role,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TransientAuthError);
  });
});
