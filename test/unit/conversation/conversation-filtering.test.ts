import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlConversationStore } from "../../../src/conversation/jsonl-store.ts";
import { InMemoryConversationStore } from "../../../src/conversation/memory-store.ts";
import type {
  ConversationAccessContext,
  ConversationStore,
  StoredMessage,
} from "../../../src/conversation/types.ts";

function msg(role: "user" | "assistant", content: string, userId?: string): StoredMessage {
  return { role, content, timestamp: new Date().toISOString(), ...(userId ? { userId } : {}) };
}

const testDir = join(tmpdir(), `nimblebrain-filtering-test-${Date.now()}`);

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

/**
 * Shared test suite that runs against both JSONL and InMemory stores.
 */
function filteringSuite(
  name: string,
  createStore: () => { store: ConversationStore; flush?: () => Promise<void> },
) {
  describe(name, () => {
    let store: ConversationStore;
    let flush: (() => Promise<void>) | undefined;

    beforeEach(() => {
      const created = createStore();
      store = created.store;
      flush = created.flush;
    });

    it("user sees own private conversations", async () => {
      await store.create({ ownerId: "user_a", visibility: "private" });
      await store.create({ ownerId: "user_a", visibility: "private" });
      await store.create({ ownerId: "user_b", visibility: "private" });

      const access: ConversationAccessContext = { userId: "user_a" };
      const result = await store.list(undefined, access);

      expect(result.totalCount).toBe(2);
      expect(result.conversations).toHaveLength(2);
    });

    it("user cannot see another user's private conversations", async () => {
      await store.create({ ownerId: "user_a", visibility: "private" });

      const access: ConversationAccessContext = { userId: "user_b" };
      const result = await store.list(undefined, access);

      expect(result.totalCount).toBe(0);
    });

    it("user sees shared conversations where they are a participant", async () => {
      await store.create({
        ownerId: "user_a",
        visibility: "shared",
        participants: ["user_a", "user_b"],
      });
      await store.create({
        ownerId: "user_a",
        visibility: "shared",
        participants: ["user_a", "user_c"],
      });

      const accessB: ConversationAccessContext = { userId: "user_b" };
      const resultB = await store.list(undefined, accessB);
      expect(resultB.totalCount).toBe(1);

      const accessC: ConversationAccessContext = { userId: "user_c" };
      const resultC = await store.list(undefined, accessC);
      expect(resultC.totalCount).toBe(1);
    });

    it("user does not see shared conversations where they are not a participant", async () => {
      await store.create({
        ownerId: "user_a",
        visibility: "shared",
        participants: ["user_a", "user_b"],
      });

      const access: ConversationAccessContext = { userId: "user_c" };
      const result = await store.list(undefined, access);
      expect(result.totalCount).toBe(0);
    });

    it("admin sees all conversations including others' private ones", async () => {
      await store.create({ ownerId: "user_a", visibility: "private" });
      await store.create({ ownerId: "user_b", visibility: "private" });
      await store.create({
        ownerId: "user_c",
        visibility: "shared",
        participants: ["user_c"],
      });

      const access: ConversationAccessContext = { userId: "admin_user", workspaceRole: "admin" };
      const result = await store.list(undefined, access);
      expect(result.totalCount).toBe(3);
    });

    it("legacy conversations (no ownerId/visibility) are visible to all users", async () => {
      // Create legacy conversation without access metadata
      await store.create();

      const access: ConversationAccessContext = { userId: "any_user" };
      const result = await store.list(undefined, access);
      expect(result.totalCount).toBe(1);
    });

    it("list without access context shows all conversations (backward compat)", async () => {
      await store.create({ ownerId: "user_a", visibility: "private" });
      await store.create({ ownerId: "user_b", visibility: "private" });
      await store.create();

      const result = await store.list();
      expect(result.totalCount).toBe(3);
    });

    it("search scopes results to visible conversations", async () => {
      const convA = await store.create({ ownerId: "user_a", visibility: "private" });
      await store.update(convA.id, { title: "Secret project" });
      if (flush) await flush();

      const convB = await store.create({ ownerId: "user_b", visibility: "private" });
      await store.update(convB.id, { title: "Secret plan" });
      if (flush) await flush();

      // user_a searches — should only see their own
      const accessA: ConversationAccessContext = { userId: "user_a" };
      const resultA = await store.list({ search: "Secret" }, accessA);
      expect(resultA.totalCount).toBe(1);

      // admin searches — sees both
      const admin: ConversationAccessContext = { userId: "admin_user", workspaceRole: "admin" };
      const resultAdmin = await store.list({ search: "Secret" }, admin);
      expect(resultAdmin.totalCount).toBe(2);
    });

    it("load returns null for a private conversation the user cannot access", async () => {
      const conv = await store.create({ ownerId: "user_a", visibility: "private" });

      const access: ConversationAccessContext = { userId: "user_b" };
      const loaded = await store.load(conv.id, access);
      expect(loaded).toBeNull();
    });

    it("load returns the conversation for the owner", async () => {
      const conv = await store.create({ ownerId: "user_a", visibility: "private" });

      const access: ConversationAccessContext = { userId: "user_a" };
      const loaded = await store.load(conv.id, access);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(conv.id);
    });

    it("load returns shared conversation for a participant", async () => {
      const conv = await store.create({
        ownerId: "user_a",
        visibility: "shared",
        participants: ["user_a", "user_b"],
      });

      const access: ConversationAccessContext = { userId: "user_b" };
      const loaded = await store.load(conv.id, access);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(conv.id);
    });

    it("load without access context returns any conversation (backward compat)", async () => {
      const conv = await store.create({ ownerId: "user_a", visibility: "private" });

      const loaded = await store.load(conv.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(conv.id);
    });

    it("admin can load any private conversation", async () => {
      const conv = await store.create({ ownerId: "user_a", visibility: "private" });

      const access: ConversationAccessContext = { userId: "admin_user", workspaceRole: "admin" };
      const loaded = await store.load(conv.id, access);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(conv.id);
    });

    it("member role does not grant special access", async () => {
      const conv = await store.create({ ownerId: "user_a", visibility: "private" });

      const access: ConversationAccessContext = { userId: "user_b", workspaceRole: "member" };
      const loaded = await store.load(conv.id, access);
      expect(loaded).toBeNull();
    });

    it("mixed visibility: user sees own private + participated shared", async () => {
      // user_a's private
      await store.create({ ownerId: "user_a", visibility: "private" });
      // user_b's private (user_a can't see)
      await store.create({ ownerId: "user_b", visibility: "private" });
      // shared with user_a
      await store.create({
        ownerId: "user_b",
        visibility: "shared",
        participants: ["user_b", "user_a"],
      });
      // shared without user_a
      await store.create({
        ownerId: "user_b",
        visibility: "shared",
        participants: ["user_b", "user_c"],
      });
      // legacy (no owner)
      await store.create();

      const access: ConversationAccessContext = { userId: "user_a" };
      const result = await store.list(undefined, access);
      // user_a's private (1) + shared with user_a (1) + legacy (1) = 3
      expect(result.totalCount).toBe(3);
    });
  });
}

// Run the suite against both store implementations
let jsonlRunCounter = 0;
filteringSuite("Conversation filtering (JSONL)", () => {
  const store = new JsonlConversationStore(
    join(testDir, `jsonl-filtering-${Date.now()}-${++jsonlRunCounter}`),
  );
  return { store, flush: () => store.flush() };
});

filteringSuite("Conversation filtering (InMemory)", () => {
  return { store: new InMemoryConversationStore() };
});
