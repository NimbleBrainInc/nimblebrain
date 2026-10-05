import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryConversationStore } from "../../src/conversation/memory-store.ts";
import type { ConversationStore, StoredMessage } from "../../src/conversation/types.ts";

function msg(role: "user" | "assistant", text: string): StoredMessage {
  return { role, content: [{ type: "text", text }], timestamp: new Date().toISOString() };
}

function assistantMsg(text: string, metadata: StoredMessage["metadata"]): StoredMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: new Date().toISOString(),
    metadata,
  };
}

function _tempDir(): string {
  const dir = join(tmpdir(), `nb-store-v2-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Shared ConversationStore contract tests, run against InMemoryConversationStore.
 */
function storeV2Tests(
  name: string,
  makeStore: () => { store: ConversationStore; cleanup: () => void },
) {
  describe(name, () => {
    let store: ConversationStore;
    let cleanup: () => void;

    beforeEach(() => {
      const s = makeStore();
      store = s.store;
      cleanup = s.cleanup;
    });

    afterEach(() => {
      cleanup();
    });

    // --- create() ---

    it("create() produces conversation with full enriched metadata", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      expect(conv.id).toMatch(/^conv_/);
      expect(conv.createdAt).toBeTruthy();
      expect(conv.updatedAt).toBe(conv.createdAt);
      expect(conv.title).toBeNull();
      expect(conv.lastModel).toBeNull();
    });

    // --- append() preserves usage data; totals derive on read ---

    it("append() preserves assistant usage so totals can be derived later", async () => {
      const conv = await store.create({ ownerId: "user_test" });

      await store.append(conv, msg("user", "Hello"));
      await store.append(
        conv,
        assistantMsg("Hi there", {
          usage: { inputTokens: 100, outputTokens: 50 },
          model: "claude-sonnet-4-5-20250929",
        }),
      );
      await store.append(
        conv,
        assistantMsg("More", {
          usage: { inputTokens: 200, outputTokens: 75 },
          model: "claude-sonnet-4-5-20250929",
        }),
      );

      // lastModel is the only display field still maintained on the
      // Conversation; tokens are derived at read time (see the
      // summary assertions below).
      expect(conv.lastModel).toBe("claude-sonnet-4-5-20250929");

      const result = await store.list();
      const summary = result.conversations.find((c) => c.id === conv.id);
      expect(summary).toBeDefined();
      expect(summary!.totalInputTokens).toBe(300);
      expect(summary!.totalOutputTokens).toBe(125);
      // claude-sonnet-4-5: input $3/M, output $15/M
      // 300 * $3/M + 125 * $15/M = $0.0009 + $0.001875 = $0.002775
      expect(summary!.totalCostUsd).toBeCloseTo(0.002775, 5);
    });

    it("append() updates updatedAt from message timestamp", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      const originalUpdatedAt = conv.updatedAt;

      const laterTimestamp = new Date(Date.now() + 5000).toISOString();
      await store.append(conv, {
        role: "user",
        content: [{ type: "text", text: "later message" }],
        timestamp: laterTimestamp,
      });

      expect(conv.updatedAt).toBe(laterTimestamp);
      expect(conv.updatedAt).not.toBe(originalUpdatedAt);
    });

    it("user-only conversations show zero derived totals", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      await store.append(conv, msg("user", "Hello"));
      const result = await store.list();
      const summary = result.conversations.find((c) => c.id === conv.id);
      expect(summary!.totalInputTokens).toBe(0);
      expect(summary!.totalOutputTokens).toBe(0);
      expect(summary!.totalCostUsd).toBe(0);
    });

    // --- history() preserves metadata ---

    it("history() preserves metadata on messages", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      await store.append(
        conv,
        assistantMsg("Result", {
          skill: "test-skill",
          toolCalls: [
            {
              id: "tc1",
              name: "test_tool",
              input: { q: "query" },
              output: "result",
              ok: true,
              ms: 42,
            },
          ],
          usage: { inputTokens: 100, outputTokens: 50 },
          model: "claude-sonnet-4-5-20250929",
        }),
      );

      const history = await store.history(conv);
      expect(history).toHaveLength(1);
      expect(history[0]!.metadata).toBeDefined();
      expect(history[0]!.metadata!.skill).toBe("test-skill");
      expect(history[0]!.metadata!.toolCalls).toHaveLength(1);
      expect(history[0]!.metadata!.usage?.inputTokens).toBe(100);
      expect(history[0]!.metadata!.model).toBe("claude-sonnet-4-5-20250929");
    });

    // --- delete() ---

    it("delete() removes conversation and returns true", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      await store.append(conv, msg("user", "Hello"));

      const result = await store.delete(conv.id);
      expect(result).toBe(true);

      const loaded = await store.load(conv.id);
      expect(loaded).toBeNull();
    });

    it("delete() returns false for non-existent conversation", async () => {
      const result = await store.delete("conv_0000000000000000");
      expect(result).toBe(false);
    });

    it("second delete() returns false", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      expect(await store.delete(conv.id)).toBe(true);
      expect(await store.delete(conv.id)).toBe(false);
    });

    // --- update() ---

    it("update() changes title in metadata", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      expect(conv.title).toBeNull();

      const updated = await store.update(conv.id, {
        title: "New Title",
      });
      expect(updated).not.toBeNull();
      expect(updated!.title).toBe("New Title");
      expect(updated!.id).toBe(conv.id);
    });

    it("update() returns null for non-existent conversation", async () => {
      const result = await store.update("conv_0000000000000000", {
        title: "Nope",
      });
      expect(result).toBeNull();
    });

    it("update() persists title on reload", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      await store.update(conv.id, { title: "Persisted Title" });

      const loaded = await store.load(conv.id);
      expect(loaded!.title).toBe("Persisted Title");
    });

    // --- fork() ---

    it("fork() creates new conversation with all messages", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      await store.append(conv, msg("user", "First"));
      await store.append(
        conv,
        assistantMsg("Second", {
          usage: { inputTokens: 100, outputTokens: 50 },
          model: "claude-sonnet-4-5-20250929",
        }),
      );
      await store.append(conv, msg("user", "Third"));

      const forked = await store.fork(conv.id);
      expect(forked).not.toBeNull();
      expect(forked!.id).not.toBe(conv.id);

      const history = await store.history(forked!);
      expect(history).toHaveLength(3);
      expect(history[0]!.content).toEqual([{ type: "text", text: "First" }]);
      expect(history[1]!.content).toEqual([{ type: "text", text: "Second" }]);
      expect(history[2]!.content).toEqual([{ type: "text", text: "Third" }]);
    });

    it("fork() with atMessage truncates messages", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      await store.append(conv, msg("user", "First"));
      await store.append(conv, msg("assistant", "Second"));
      await store.append(conv, msg("user", "Third"));

      const forked = await store.fork(conv.id, 2);
      expect(forked).not.toBeNull();

      const history = await store.history(forked!);
      expect(history).toHaveLength(2);
      expect(history[0]!.content).toEqual([{ type: "text", text: "First" }]);
      expect(history[1]!.content).toEqual([{ type: "text", text: "Second" }]);
    });

    it("fork() with atMessage=0 creates empty conversation", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      await store.append(conv, msg("user", "First"));

      const forked = await store.fork(conv.id, 0);
      expect(forked).not.toBeNull();

      const history = await store.history(forked!);
      expect(history).toHaveLength(0);
    });

    it("fork() returns null for non-existent conversation", async () => {
      const result = await store.fork("conv_0000000000000000");
      expect(result).toBeNull();
    });

    it("fork() carries forward usage so derived totals match the slice", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      await store.append(conv, msg("user", "Hello"));
      await store.append(
        conv,
        assistantMsg("Reply 1", {
          usage: { inputTokens: 100, outputTokens: 50 },
          model: "claude-sonnet-4-5-20250929",
        }),
      );
      await store.append(conv, msg("user", "More"));
      await store.append(
        conv,
        assistantMsg("Reply 2", {
          usage: { inputTokens: 200, outputTokens: 75 },
          model: "claude-sonnet-4-5-20250929",
        }),
      );

      // Fork with only first 2 messages (user + first assistant). The
      // totals come from re-deriving over the copied messages on read.
      const forked = await store.fork(conv.id, 2);
      const result = await store.list();
      const summary = result.conversations.find((c) => c.id === forked!.id);
      expect(summary).toBeDefined();
      expect(summary!.totalInputTokens).toBe(100);
      expect(summary!.totalOutputTokens).toBe(50);
    });

    // --- list() with search ---

    it("list() search matches a title set by update(), after a later append", async () => {
      const conv1 = await store.create({ ownerId: "user_test" });
      await store.update(conv1.id, { title: "Deploy Pipeline" });
      await store.append(conv1, msg("user", "ship it"));

      const conv2 = await store.create({ ownerId: "user_test" });
      await store.update(conv2.id, { title: "Budget Review" });
      await store.append(conv2, msg("user", "numbers please"));

      const result = await store.list({ search: "pipeline" });
      expect(result.conversations.map((c) => c.id)).toEqual([conv1.id]);
    });

    it("list() search matches the first user message's text", async () => {
      const conv1 = await store.create({ ownerId: "user_test" });
      await store.append(conv1, msg("user", "Deploy stuff"));

      const conv2 = await store.create({ ownerId: "user_test" });
      await store.append(conv2, msg("user", "Review budget"));

      const result = await store.list({ search: "stuff" });
      expect(result.conversations.map((c) => c.id)).toEqual([conv1.id]);
      expect(result.conversations[0]!.preview).toBe("Deploy stuff");
    });

    it("append() with a copy that predates update() keeps the stored title", async () => {
      const conv = await store.create({ ownerId: "user_test" });
      await store.update(conv.id, { title: "Generated title" });
      // `conv` still has title: null, as a caller's copy does when a background
      // auto-title lands between its turns.
      await store.append(conv, msg("user", "next turn"));

      const listed = (await store.list()).conversations.find((c) => c.id === conv.id);
      expect(listed?.title).toBe("Generated title");
      expect((await store.load(conv.id))?.title).toBe("Generated title");
    });
  });
}

storeV2Tests("InMemoryConversationStore (v2)", () => ({
  store: new InMemoryConversationStore(),
  cleanup: () => {},
}));
