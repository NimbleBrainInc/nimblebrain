/**
 * `WorkosIdentityProvider.updateUser` writes WorkOS, then the local profile.
 *
 * WorkOS is the source of a user's name and admin/member role, and the login
 * sync copies both back over the local profile, so an edit written only
 * locally would revert on the next uncached sign-in. Email is owned by WorkOS
 * and refused.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";
import { UserStore } from "../../../src/identity/user.ts";

let workDir: string;
let userStore: UserStore;

const BASE_CONFIG: WorkosAuth = {
  adapter: "workos",
  clientId: "client_test",
  organizationId: "org_test123",
  apiKey: "sk_test_fake",
};

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-workos-update-"));
  userStore = new UserStore(workDir);
  await userStore.create({
    id: "user_bo",
    email: "bo@example.com",
    displayName: "Bo Old",
    orgRole: "member",
  });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

interface Recorded {
  userUpdates: Array<Record<string, unknown>>;
  roleUpdates: Array<[string, Record<string, unknown>]>;
}

/** A provider whose WorkOS calls are recorded; `slug` is the user's current membership role. */
function makeProvider(slug: string | null, configOverride?: Partial<WorkosAuth>) {
  const provider = new WorkosIdentityProvider({ ...BASE_CONFIG, ...configOverride }, userStore);
  const recorded: Recorded = { userUpdates: [], roleUpdates: [] };
  const workos = (provider as unknown as { workos: Record<string, unknown> }).workos;
  workos.userManagement = {
    updateUser: async (payload: Record<string, unknown>) => {
      recorded.userUpdates.push(payload);
      return payload;
    },
    listOrganizationMemberships: async () => ({
      data: slug === null ? [] : [{ id: "om_bo", role: { slug } }],
    }),
    updateOrganizationMembership: async (id: string, opts: Record<string, unknown>) => {
      recorded.roleUpdates.push([id, opts]);
      return {};
    },
  };
  return { provider, recorded };
}

describe("WorkOS updateUser", () => {
  it("declares email as provider-owned", () => {
    const { provider } = makeProvider("member");
    expect(provider.capabilities.providerOwnedUserFields).toEqual(["email"]);
  });

  it("writes a new display name to WorkOS as first and last name, then locally", async () => {
    const { provider, recorded } = makeProvider("member");
    const updated = await provider.updateUser("user_bo", { displayName: "Bo  Van Dyke" });

    expect(recorded.userUpdates).toEqual([
      { userId: "user_bo", firstName: "Bo", lastName: "Van Dyke" },
    ]);
    expect(updated?.displayName).toBe("Bo Van Dyke");
  });

  it("clears the WorkOS last name for a one-word name", async () => {
    const { provider, recorded } = makeProvider("member");
    await provider.updateUser("user_bo", { displayName: "Bo" });
    expect(recorded.userUpdates).toEqual([{ userId: "user_bo", firstName: "Bo", lastName: "" }]);
  });

  it("refuses an email change", async () => {
    const { provider, recorded } = makeProvider("member");
    await expect(provider.updateUser("user_bo", { email: "new@example.com" })).rejects.toThrow(
      "Email is managed in WorkOS",
    );
    expect(recorded.userUpdates).toEqual([]);
    expect((await userStore.get("user_bo"))?.email).toBe("bo@example.com");
  });

  it("makes a member an admin with the first configured admin slug", async () => {
    const { provider, recorded } = makeProvider("member", { adminRoleSlugs: ["org-admin"] });
    const updated = await provider.updateUser("user_bo", { orgRole: "admin" });

    expect(recorded.roleUpdates).toEqual([["om_bo", { roleSlug: "org-admin" }]]);
    expect(updated?.orgRole).toBe("admin");
  });

  it("makes an admin a member with the member slug", async () => {
    await userStore.update("user_bo", { orgRole: "admin" });
    const { provider, recorded } = makeProvider("admin");
    await provider.updateUser("user_bo", { orgRole: "member" });
    expect(recorded.roleUpdates).toEqual([["om_bo", { roleSlug: "member" }]]);
  });

  it("leaves a membership whose slug already maps to the role", async () => {
    // WorkOS's own `owner` slug already maps to app admin; the local profile
    // is stale until the next sign-in.
    const { provider, recorded } = makeProvider("owner");
    const updated = await provider.updateUser("user_bo", { orgRole: "admin" });

    expect(recorded.roleUpdates).toEqual([]);
    expect(updated?.orgRole).toBe("admin");
  });

  it("refuses a role change for a user with no membership, and stores nothing", async () => {
    const { provider } = makeProvider(null);
    await expect(provider.updateUser("user_bo", { orgRole: "admin" })).rejects.toThrow(
      "no membership",
    );
    expect((await userStore.get("user_bo"))?.orgRole).toBe("member");
  });

  it("refuses admin when no organization is configured", async () => {
    const { provider } = makeProvider("member", { organizationId: undefined });
    await expect(provider.updateUser("user_bo", { orgRole: "admin" })).rejects.toThrow(
      "no one can be an admin",
    );
  });

  it("returns null for a user with no local profile", async () => {
    const { provider, recorded } = makeProvider("member");
    expect(await provider.updateUser("user_ghost", { displayName: "Ghost" })).toBeNull();
    expect(recorded.userUpdates).toEqual([]);
  });
});
