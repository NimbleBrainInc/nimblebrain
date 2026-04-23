import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { DevIdentityProvider } from "../../../src/identity/providers/dev.ts";
import { UserStore } from "../../../src/identity/user.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

let workDir: string;
let userStore: UserStore;
let workspaceStore: WorkspaceStore;
let warnSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-dev-adapter-test-"));
  userStore = new UserStore(workDir);
  workspaceStore = new WorkspaceStore(workDir);
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  warnSpy.mockRestore();
  await rm(workDir, { recursive: true, force: true });
});

// ── Helper ─────────────────────────────────────────────────────────

function dummyRequest(): Request {
  return new Request("http://localhost/test");
}

// ── Tests ──────────────────────────────────────────────────────────

describe("DevIdentityProvider", () => {
  test("logs warning on construction", () => {
    new DevIdentityProvider(workDir, userStore, workspaceStore);
    expect(warnSpy).toHaveBeenCalledWith(
      "Running in dev mode — no authentication configured",
    );
  });

  describe("verifyRequest", () => {
    test("returns default UserIdentity for any request", async () => {
      const adapter = new DevIdentityProvider(workDir, userStore, workspaceStore);
      const identity = await adapter.verifyRequest(dummyRequest());

      expect(identity).not.toBeNull();
      expect(identity!.id).toBe("usr_default");
      expect(identity!.email).toBe("dev@localhost");
      expect(identity!.displayName).toBe("Developer");
      expect(identity!.orgRole).toBe("owner");
    });

    test("returns same identity for requests without auth headers", async () => {
      const adapter = new DevIdentityProvider(workDir, userStore, workspaceStore);
      const req = new Request("http://localhost/test");
      const identity = await adapter.verifyRequest(req);

      expect(identity).not.toBeNull();
      expect(identity!.id).toBe("usr_default");
    });

    test("returns same identity for requests with auth headers (ignores them)", async () => {
      const adapter = new DevIdentityProvider(workDir, userStore, workspaceStore);
      const req = new Request("http://localhost/test", {
        headers: { Authorization: "Bearer some-token" },
      });
      const identity = await adapter.verifyRequest(req);

      expect(identity).not.toBeNull();
      expect(identity!.id).toBe("usr_default");
    });

    test("default user has orgRole owner (can do everything)", async () => {
      const adapter = new DevIdentityProvider(workDir, userStore, workspaceStore);
      const identity = await adapter.verifyRequest(dummyRequest());
      expect(identity!.orgRole).toBe("owner");
    });
  });

  describe("auto-provisioning", () => {
    test("creates default user profile on first request", async () => {
      const adapter = new DevIdentityProvider(workDir, userStore, workspaceStore);

      // No user exists yet
      const before = await userStore.get("usr_default");
      expect(before).toBeNull();

      await adapter.verifyRequest(dummyRequest());

      // User was created
      const after = await userStore.get("usr_default");
      expect(after).not.toBeNull();
      expect(after!.id).toBe("usr_default");
      expect(after!.email).toBe("dev@localhost");
      expect(after!.displayName).toBe("Developer");
      expect(after!.orgRole).toBe("owner");
    });

    test("does not recreate user if usr_default already exists", async () => {
      const adapter1 = new DevIdentityProvider(workDir, userStore, workspaceStore);
      await adapter1.verifyRequest(dummyRequest());

      const firstUser = await userStore.get("usr_default");
      expect(firstUser).not.toBeNull();
      const firstCreatedAt = firstUser!.createdAt;

      // Create a new adapter (simulates restart)
      const adapter2 = new DevIdentityProvider(workDir, userStore, workspaceStore);
      await adapter2.verifyRequest(dummyRequest());

      const secondUser = await userStore.get("usr_default");
      expect(secondUser).not.toBeNull();
      // createdAt should be unchanged — user was not recreated
      expect(secondUser!.createdAt).toBe(firstCreatedAt);
    });

    test("multiple requests reuse the same default user (idempotent)", async () => {
      const adapter = new DevIdentityProvider(workDir, userStore, workspaceStore);

      const id1 = await adapter.verifyRequest(dummyRequest());
      const id2 = await adapter.verifyRequest(dummyRequest());
      const id3 = await adapter.verifyRequest(dummyRequest());

      expect(id1).toEqual(id2);
      expect(id2).toEqual(id3);

      // Still only one user
      const users = await userStore.list();
      expect(users).toHaveLength(1);
    });

    test("creates a workspace for the default user when workspaceStore is wired", async () => {
      const adapter = new DevIdentityProvider(workDir, userStore, workspaceStore);

      // Invariant: workspace exists by the time verifyRequest resolves.
      expect((await workspaceStore.list()).length).toBe(0);
      await adapter.verifyRequest(dummyRequest());

      const workspaces = await workspaceStore.getWorkspacesForUser("usr_default");
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]!.members).toEqual([{ userId: "usr_default", role: "admin" }]);
    });

    test("workspace provisioning is idempotent across restarts", async () => {
      const adapter1 = new DevIdentityProvider(workDir, userStore, workspaceStore);
      await adapter1.verifyRequest(dummyRequest());
      const firstList = await workspaceStore.list();

      const adapter2 = new DevIdentityProvider(workDir, userStore, workspaceStore);
      await adapter2.verifyRequest(dummyRequest());
      const secondList = await workspaceStore.list();

      expect(secondList).toHaveLength(firstList.length);
    });
  });

  describe("delegation to UserStore", () => {
    test("listUsers delegates to UserStore", async () => {
      const adapter = new DevIdentityProvider(workDir, userStore, workspaceStore);

      // Trigger auto-provisioning first
      await adapter.verifyRequest(dummyRequest());

      const users = await adapter.listUsers();
      expect(users).toHaveLength(1);
      expect(users[0].id).toBe("usr_default");
    });

    test("createUser delegates to UserStore", async () => {
      const adapter = new DevIdentityProvider(workDir, userStore, workspaceStore);
      const { user } = await adapter.createUser({ email: "alice@example.com", displayName: "Alice", orgRole: "member" });

      expect(user.email).toBe("alice@example.com");
      expect(user.displayName).toBe("Alice");
      expect(user.orgRole).toBe("member");

      // Verify it's in the store
      const found = await userStore.getByEmail("alice@example.com");
      expect(found).not.toBeNull();
    });

    test("deleteUser delegates to UserStore", async () => {
      const adapter = new DevIdentityProvider(workDir, userStore, workspaceStore);
      const { user } = await adapter.createUser({ email: "bob@example.com", displayName: "Bob", orgRole: "member" });

      const deleted = await adapter.deleteUser(user.id);
      expect(deleted).toBe(true);

      const found = await userStore.get(user.id);
      expect(found).toBeNull();
    });

    test("deleteUser returns false for nonexistent user", async () => {
      const adapter = new DevIdentityProvider(workDir, userStore, workspaceStore);
      const result = await adapter.deleteUser("usr_doesnotexist00");
      expect(result).toBe(false);
    });
  });
});
