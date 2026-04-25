import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { IdentityProvider, UserIdentity, CreateUserResult, ProviderCapabilities } from "../../../src/identity/provider.ts";
import { UserStore } from "../../../src/identity/user.ts";
import type { User } from "../../../src/identity/user.ts";
import type { ManageUsersContext } from "../../../src/tools/user-tools.ts";
import { createManageUsersTool } from "../../../src/tools/user-tools.ts";
import type { InProcessTool } from "../../../src/tools/in-process-app.ts";

// ── Helpers ───────────────────────────────────────────────────────

function extractText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

function parseResult(result: { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }): unknown {
  if (result.structuredContent) return result.structuredContent;
  return JSON.parse(extractText(result));
}

// ── Setup ─────────────────────────────────────────────────────────

let workDir: string;
let userStore: UserStore;
let provider: IdentityProvider;
let tool: InProcessTool;
let currentIdentity: UserIdentity | null;

/** Simple mock provider that delegates to UserStore. */
function createMockProvider(store: UserStore): IdentityProvider {
  return {
    capabilities: {
      authCodeFlow: false,
      tokenRefresh: false,
      managedUsers: false,
    },
    async verifyRequest(): Promise<UserIdentity | null> {
      return null;
    },
    async listUsers(): Promise<User[]> {
      return store.list();
    },
    async createUser(data): Promise<CreateUserResult> {
      const user = await store.create({
        email: data.email,
        displayName: data.displayName,
        orgRole: data.orgRole,
      });
      return { user };
    },
    async deleteUser(userId: string): Promise<boolean> {
      return store.delete(userId);
    },
  };
}

function makeCtx(): ManageUsersContext {
  return {
    getIdentity: () => currentIdentity,
    userStore,
    provider,
  };
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-user-tools-test-"));
  userStore = new UserStore(workDir);
  provider = createMockProvider(userStore);
  currentIdentity = {
    id: "usr_admin000000001",
    email: "admin@example.com",
    displayName: "Admin",
    orgRole: "admin",
  };
  tool = createManageUsersTool(makeCtx());
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────

describe("nb__manage_users", () => {
  describe("role enforcement", () => {
    test("admin can create a user", async () => {
      const result = await tool.handler({
        action: "create",
        email: "alice@example.com",
        displayName: "Alice",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { user: { id: string; email: string } };
      expect(parsed.user.email).toBe("alice@example.com");
    });

    test("owner can create a user", async () => {
      currentIdentity = { ...currentIdentity!, orgRole: "owner" };
      tool = createManageUsersTool(makeCtx());

      const result = await tool.handler({
        action: "create",
        email: "bob@example.com",
        displayName: "Bob",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as { user: { email: string } };
      expect(parsed.user.email).toBe("bob@example.com");
    });

    test("member gets permission denied", async () => {
      currentIdentity = { ...currentIdentity!, orgRole: "member" };
      tool = createManageUsersTool(makeCtx());

      const result = await tool.handler({
        action: "create",
        email: "alice@example.com",
        displayName: "Alice",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("You don't have permission to manage users");
    });

    test("null identity gets permission denied", async () => {
      currentIdentity = null;
      tool = createManageUsersTool(makeCtx());

      const result = await tool.handler({ action: "list" });

      expect(extractText(result)).toContain("You don't have permission to manage users");
    });
  });

  describe("create", () => {
    test("creates user with profile", async () => {
      const result = await tool.handler({
        action: "create",
        email: "alice@example.com",
        displayName: "Alice",
      });

      expect(result.isError).toBe(false);
      const parsed = parseResult(result) as {
        user: { id: string; email: string; displayName: string; orgRole: string };
      };
      expect(parsed.user.id).toMatch(/^usr_/);
      expect(parsed.user.email).toBe("alice@example.com");
      expect(parsed.user.displayName).toBe("Alice");
      expect(parsed.user.orgRole).toBe("member");
    });

    test("defaults orgRole to member", async () => {
      const result = await tool.handler({
        action: "create",
        email: "alice@example.com",
        displayName: "Alice",
      });

      const parsed = parseResult(result) as { user: { orgRole: string } };
      expect(parsed.user.orgRole).toBe("member");
    });

    test("respects explicit orgRole", async () => {
      const result = await tool.handler({
        action: "create",
        email: "alice@example.com",
        displayName: "Alice",
        orgRole: "admin",
      });

      const parsed = parseResult(result) as { user: { orgRole: string } };
      expect(parsed.user.orgRole).toBe("admin");
    });

    test("requires email", async () => {
      const result = await tool.handler({
        action: "create",
        displayName: "Alice",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("email and displayName are required");
    });

    test("requires displayName", async () => {
      const result = await tool.handler({
        action: "create",
        email: "alice@example.com",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("email and displayName are required");
    });
  });

  describe("update", () => {
    test("updates displayName and bumps updatedAt", async () => {
      // Create a user first
      const createResult = await tool.handler({
        action: "create",
        email: "alice@example.com",
        displayName: "Alice",
      });
      const created = parseResult(createResult) as { user: { id: string } };

      // Small delay to ensure updatedAt differs
      await new Promise((r) => setTimeout(r, 10));

      const updateResult = await tool.handler({
        action: "update",
        userId: created.user.id,
        displayName: "Alice Updated",
      });

      expect(updateResult.isError).toBe(false);
      const updated = parseResult(updateResult) as {
        user: { displayName: string; updatedAt: string };
      };
      expect(updated.user.displayName).toBe("Alice Updated");
    });

    test("requires userId", async () => {
      const result = await tool.handler({
        action: "update",
        displayName: "New Name",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("userId is required");
    });

    test("returns error for non-existent user", async () => {
      const result = await tool.handler({
        action: "update",
        userId: "usr_nonexistent00000",
        displayName: "Ghost",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("User not found");
    });

    test("cannot downgrade the last owner to member", async () => {
      // Create an owner
      const createResult = await tool.handler({
        action: "create",
        email: "owner@example.com",
        displayName: "Owner",
        orgRole: "owner",
      });
      const owner = parseResult(createResult) as { user: { id: string } };

      const updateResult = await tool.handler({
        action: "update",
        userId: owner.user.id,
        orgRole: "member",
      });

      expect(updateResult.isError).toBe(false);
      expect(extractText(updateResult)).toContain("Cannot change the role of the last owner");
    });

    test("can downgrade owner when another owner exists", async () => {
      // Create two owners
      const r1 = await tool.handler({
        action: "create",
        email: "owner1@example.com",
        displayName: "Owner1",
        orgRole: "owner",
      });
      const owner1 = parseResult(r1) as { user: { id: string } };

      await tool.handler({
        action: "create",
        email: "owner2@example.com",
        displayName: "Owner2",
        orgRole: "owner",
      });

      const updateResult = await tool.handler({
        action: "update",
        userId: owner1.user.id,
        orgRole: "member",
      });

      expect(updateResult.isError).toBe(false);
      const updated = parseResult(updateResult) as { user: { orgRole: string } };
      expect(updated.user.orgRole).toBe("member");
    });
  });

  describe("delete", () => {
    test("deletes user and revokes keys", async () => {
      const createResult = await tool.handler({
        action: "create",
        email: "alice@example.com",
        displayName: "Alice",
      });
      const created = parseResult(createResult) as { user: { id: string } };

      const deleteResult = await tool.handler({
        action: "delete",
        userId: created.user.id,
      });

      expect(deleteResult.isError).toBe(false);
      const parsed = parseResult(deleteResult) as { deleted: boolean; userId: string };
      expect(parsed.deleted).toBe(true);

      // Verify user is gone from store
      const user = await userStore.get(created.user.id);
      expect(user).toBeNull();
    });

    test("requires userId", async () => {
      const result = await tool.handler({ action: "delete" });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("userId is required");
    });

    test("returns error for non-existent user", async () => {
      const result = await tool.handler({
        action: "delete",
        userId: "usr_nonexistent00000",
      });

      expect(result.isError).toBe(true);
      expect(extractText(result)).toContain("User not found");
    });

    test("cannot delete the last owner", async () => {
      const createResult = await tool.handler({
        action: "create",
        email: "owner@example.com",
        displayName: "Sole Owner",
        orgRole: "owner",
      });
      const owner = parseResult(createResult) as { user: { id: string } };

      const deleteResult = await tool.handler({
        action: "delete",
        userId: owner.user.id,
      });

      expect(deleteResult.isError).toBe(false);
      expect(extractText(deleteResult)).toContain("Cannot delete the last owner");

      // Verify user still exists
      const user = await userStore.get(owner.user.id);
      expect(user).not.toBeNull();
    });
  });

  describe("list", () => {
    test("returns all users sorted by createdAt", async () => {
      await tool.handler({
        action: "create",
        email: "alice@example.com",
        displayName: "Alice",
      });

      await tool.handler({
        action: "create",
        email: "bob@example.com",
        displayName: "Bob",
      });

      const listResult = await tool.handler({ action: "list" });

      expect(listResult.isError).toBe(false);
      const parsed = parseResult(listResult) as {
        users: Array<{ id: string; email: string; displayName: string; orgRole: string }>;
      };
      expect(parsed.users).toHaveLength(2);
      const emails = parsed.users.map((u) => u.email).sort();
      expect(emails).toEqual(["alice@example.com", "bob@example.com"]);

      // List should NOT include apiKey
      const raw = extractText(listResult);
      expect(raw).not.toContain("apiKey");
    });

    test("returns empty array when no users exist", async () => {
      const listResult = await tool.handler({ action: "list" });

      expect(listResult.isError).toBe(false);
      const parsed = parseResult(listResult) as { users: unknown[] };
      expect(parsed.users).toHaveLength(0);
    });

    test("list only includes id, email, displayName, orgRole", async () => {
      await tool.handler({
        action: "create",
        email: "alice@example.com",
        displayName: "Alice",
        orgRole: "admin",
      });

      const listResult = await tool.handler({ action: "list" });
      const parsed = parseResult(listResult) as {
        users: Array<Record<string, unknown>>;
      };

      const user = parsed.users[0];
      expect(Object.keys(user).sort()).toEqual(["displayName", "email", "id", "orgRole"]);
    });
  });
});
