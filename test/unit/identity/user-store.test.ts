import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UserConflictError, UserStore } from "../../../src/identity/user.ts";
import type { User } from "../../../src/identity/user.ts";

let workDir: string;
let store: UserStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-user-store-test-"));
  store = new UserStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("UserStore", () => {
  describe("create", () => {
    test("writes profile.json to the correct directory", async () => {
      const user = await store.create({
        email: "alice@example.com",
        displayName: "Alice",
      });

      expect(user.id).toMatch(/^usr_[a-f0-9]{16}$/);
      expect(user.email).toBe("alice@example.com");
      expect(user.displayName).toBe("Alice");
      expect(user.orgRole).toBe("member");
      expect(user.preferences).toEqual({});
      expect(user.identity).toBeUndefined();
      expect(user.createdAt).toBeTruthy();
      expect(user.updatedAt).toBe(user.createdAt);

      // Verify file exists on disk
      const filePath = join(workDir, "users", user.id, "profile.json");
      const content = await readFile(filePath, "utf-8");
      const persisted = JSON.parse(content) as User;
      expect(persisted.id).toBe(user.id);
      expect(persisted.email).toBe("alice@example.com");
    });

    test("throws conflict error for duplicate email", async () => {
      await store.create({ email: "dup@example.com", displayName: "First" });

      expect(
        store.create({ email: "dup@example.com", displayName: "Second" }),
      ).rejects.toThrow(UserConflictError);
    });

    test("respects optional fields", async () => {
      const user = await store.create({
        email: "bob@example.com",
        displayName: "Bob",
        orgRole: "admin",
        preferences: { theme: "dark", timezone: "Pacific/Honolulu" },
        identity: "You are a helpful assistant.",
        integrationEntityId: "ext-123",
      });

      expect(user.orgRole).toBe("admin");
      expect(user.preferences.theme).toBe("dark");
      expect(user.identity).toBe("You are a helpful assistant.");
      expect(user.integrationEntityId).toBe("ext-123");
    });
  });

  describe("get", () => {
    test("returns user by ID", async () => {
      const created = await store.create({
        email: "charlie@example.com",
        displayName: "Charlie",
      });

      const fetched = await store.get(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.email).toBe("charlie@example.com");
      expect(fetched!.displayName).toBe("Charlie");
    });

    test("returns null for nonexistent ID", async () => {
      const result = await store.get("usr_doesnotexist0000");
      expect(result).toBeNull();
    });
  });

  describe("getByEmail", () => {
    test("scans all profiles and returns the match", async () => {
      await store.create({ email: "a@example.com", displayName: "A" });
      const target = await store.create({ email: "b@example.com", displayName: "B" });
      await store.create({ email: "c@example.com", displayName: "C" });

      const found = await store.getByEmail("b@example.com");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(target.id);
    });

    test("returns null for unknown email", async () => {
      await store.create({ email: "known@example.com", displayName: "Known" });
      const result = await store.getByEmail("unknown@example.com");
      expect(result).toBeNull();
    });
  });

  describe("list", () => {
    test("returns all profiles sorted by createdAt", async () => {
      const first = await store.create({ email: "first@example.com", displayName: "First" });
      await new Promise((r) => setTimeout(r, 10));
      const second = await store.create({ email: "second@example.com", displayName: "Second" });
      await new Promise((r) => setTimeout(r, 10));
      const third = await store.create({ email: "third@example.com", displayName: "Third" });

      const users = await store.list();
      expect(users).toHaveLength(3);
      expect(users[0].id).toBe(first.id);
      expect(users[1].id).toBe(second.id);
      expect(users[2].id).toBe(third.id);
    });

    test("returns empty array when no users exist", async () => {
      const users = await store.list();
      expect(users).toEqual([]);
    });
  });

  describe("update", () => {
    test("patches only specified fields and bumps updatedAt", async () => {
      const user = await store.create({
        email: "update@example.com",
        displayName: "Original",
      });
      const originalUpdatedAt = user.updatedAt;

      // Small delay to ensure updatedAt changes
      await new Promise((r) => setTimeout(r, 10));

      const updated = await store.update(user.id, { displayName: "Updated" });
      expect(updated).not.toBeNull();
      expect(updated!.displayName).toBe("Updated");
      expect(updated!.email).toBe("update@example.com"); // unchanged
      expect(updated!.updatedAt).not.toBe(originalUpdatedAt);

      // Verify persisted
      const fetched = await store.get(user.id);
      expect(fetched!.displayName).toBe("Updated");
    });

    test("returns null for nonexistent user", async () => {
      const result = await store.update("usr_doesnotexist0000", { displayName: "Nope" });
      expect(result).toBeNull();
    });

    test("throws conflict when updating to an existing email", async () => {
      await store.create({ email: "taken@example.com", displayName: "Taken" });
      const user = await store.create({ email: "mine@example.com", displayName: "Mine" });

      expect(
        store.update(user.id, { email: "taken@example.com" }),
      ).rejects.toThrow(UserConflictError);
    });
  });

  describe("delete", () => {
    test("removes the user directory", async () => {
      const user = await store.create({
        email: "delete@example.com",
        displayName: "DeleteMe",
      });

      const deleted = await store.delete(user.id);
      expect(deleted).toBe(true);

      // Verify directory is gone
      const fetched = await store.get(user.id);
      expect(fetched).toBeNull();
    });

    test("returns false for nonexistent user", async () => {
      const result = await store.delete("usr_doesnotexist0000");
      expect(result).toBe(false);
    });

    test("deleted user does not appear in list", async () => {
      const user = await store.create({
        email: "ghost@example.com",
        displayName: "Ghost",
      });
      await store.delete(user.id);

      const users = await store.list();
      expect(users).toHaveLength(0);
    });
  });
});
