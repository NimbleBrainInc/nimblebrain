import { describe, expect, it, beforeEach, afterAll } from "bun:test";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryConversationStore } from "../../src/conversation/memory-store.ts";
import { JsonlConversationStore } from "../../src/conversation/jsonl-store.ts";
import { windowMessages } from "../../src/conversation/window.ts";
import type { ConversationStore, StoredMessage } from "../../src/conversation/types.ts";
import type { Message } from "../../src/engine/types.ts";

function msg(role: "user" | "assistant", content: string): StoredMessage {
  return { role, content, timestamp: new Date().toISOString() };
}

function conversationTests(name: string, makeStore: () => ConversationStore) {
  describe(name, () => {
    let store: ConversationStore;

    beforeEach(() => {
      store = makeStore();
    });

    it("creates a conversation with a unique id", async () => {
      const conv = await store.create();
      expect(conv.id).toMatch(/^conv_/);
      expect(conv.createdAt).toBeTruthy();
    });

    it("loads an existing conversation", async () => {
      const conv = await store.create();
      const loaded = await store.load(conv.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.id).toBe(conv.id);
    });

    it("returns null for unknown conversation", async () => {
      const loaded = await store.load("conv_0000000000000000");
      expect(loaded).toBeNull();
    });

    it("appends and retrieves messages", async () => {
      const conv = await store.create();
      await store.append(conv, msg("user", "Hello"));
      await store.append(conv, msg("assistant", "Hi there"));
      await store.append(conv, msg("user", "How are you?"));

      const history = await store.history(conv);
      expect(history).toHaveLength(3);
      expect(history[0]!.role).toBe("user");
      expect(history[0]!.content).toBe("Hello");
      expect(history[1]!.role).toBe("assistant");
      expect(history[2]!.content).toBe("How are you?");
    });

    it("respects limit parameter", async () => {
      const conv = await store.create();
      await store.append(conv, msg("user", "First"));
      await store.append(conv, msg("assistant", "Second"));
      await store.append(conv, msg("user", "Third"));

      const history = await store.history(conv, 2);
      expect(history).toHaveLength(2);
      expect(history[0]!.content).toBe("Second");
      expect(history[1]!.content).toBe("Third");
    });

    it("returns empty history for new conversation", async () => {
      const conv = await store.create();
      const history = await store.history(conv);
      expect(history).toHaveLength(0);
    });

    it("preserves metadata in history output", async () => {
      const conv = await store.create();
      await store.append(conv, {
        ...msg("assistant", "Matched skill"),
        metadata: { skill: "test-skill", toolCalls: [] },
      });

      const history = await store.history(conv);
      expect(history[0]!.role).toBe("assistant");
      expect(history[0]!.content).toBe("Matched skill");
      expect(history[0]!.metadata).toBeDefined();
      expect(history[0]!.metadata!.skill).toBe("test-skill");
    });
  });
}

// In-memory tests
conversationTests("InMemoryConversationStore", () => new InMemoryConversationStore());

// JSONL tests
const testDir = join(tmpdir(), `nimblebrain-test-${Date.now()}`);
conversationTests("JsonlConversationStore", () => new JsonlConversationStore(testDir));

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("JsonlConversationStore (persistence)", () => {
  const persistDir = join(tmpdir(), `nimblebrain-persist-${Date.now()}`);

  afterAll(() => {
    if (existsSync(persistDir)) rmSync(persistDir, { recursive: true });
  });

  it("persists across store instances", async () => {
    const store1 = new JsonlConversationStore(persistDir);
    const conv = await store1.create();
    await store1.append(conv, msg("user", "Remember me"));

    // New instance, same directory
    const store2 = new JsonlConversationStore(persistDir);
    const loaded = await store2.load(conv.id);
    expect(loaded).not.toBeNull();

    const history = await store2.history(loaded!);
    expect(history).toHaveLength(1);
    expect(history[0]!.content).toBe("Remember me");
  });
});

describe("windowMessages", () => {
  function wmsg(role: "user" | "assistant", text: string): Message {
    return { role, content: text };
  }

  it("returns all messages when under budget", () => {
    const messages = [
      wmsg("user", "Hello"),
      wmsg("assistant", "Hi there"),
      wmsg("user", "How are you?"),
    ];
    // Each message is short, 1000 tokens is plenty
    const result = windowMessages(messages, 1000);
    expect(result).toEqual(messages);
    expect(result).toHaveLength(3);
  });

  it("keeps first message and most recent messages within budget", () => {
    // Create 10 messages, each ~25 tokens (100 chars / 4)
    const messages: Message[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(
        wmsg(
          i % 2 === 0 ? "user" : "assistant",
          `Message number ${i}: ${"x".repeat(80)}`,
        ),
      );
    }

    // Budget for ~3 messages worth of tokens
    const result = windowMessages(messages, 75);

    // Should keep first message + some recent messages
    expect(result[0]).toBe(messages[0]); // First preserved
    expect(result[result.length - 1]).toBe(messages[messages.length - 1]); // Last preserved
    expect(result.length).toBeLessThan(messages.length); // Some dropped
    expect(result.length).toBeGreaterThanOrEqual(2); // At least first + last
  });

  it("preserves first and last messages", () => {
    const messages = [
      wmsg("user", "A".repeat(100)), // ~25 tokens
      wmsg("assistant", "B".repeat(100)),
      wmsg("user", "C".repeat(100)),
      wmsg("assistant", "D".repeat(100)),
      wmsg("user", "E".repeat(100)), // ~25 tokens
    ];

    // Budget for first + 2 messages (~75 tokens)
    const result = windowMessages(messages, 75);

    expect(result[0]).toBe(messages[0]); // First always kept
    expect(result[result.length - 1]).toBe(messages[messages.length - 1]); // Most recent kept
  });

  it("handles 2 messages (minimum)", () => {
    const messages = [wmsg("user", "Hello"), wmsg("assistant", "Hi")];
    const result = windowMessages(messages, 1); // Very small budget
    expect(result).toHaveLength(2); // Always keeps both when only 2
  });

  it("handles single message", () => {
    const messages = [wmsg("user", "Hello")];
    const result = windowMessages(messages, 1);
    expect(result).toHaveLength(1);
  });

  it("handles empty messages", () => {
    const result = windowMessages([], 1000);
    expect(result).toHaveLength(0);
  });

  it("drops middle messages when budget is tight", () => {
    const messages = [
      wmsg("user", "First: " + "a".repeat(40)), // ~12 tokens
      wmsg("assistant", "Second: " + "b".repeat(400)), // ~100 tokens (big)
      wmsg("user", "Third: " + "c".repeat(400)), // ~100 tokens (big)
      wmsg("assistant", "Fourth: " + "d".repeat(40)), // ~12 tokens
      wmsg("user", "Fifth: " + "e".repeat(40)), // ~12 tokens
    ];

    // Budget: 50 tokens — enough for first (~12) + fourth (~12) + fifth (~12) = 36
    // But NOT enough for second or third (~100 each)
    const result = windowMessages(messages, 50);

    expect(result[0]).toBe(messages[0]); // First kept
    expect(result).toContain(messages[4]); // Last kept
    expect(result).not.toContain(messages[1]); // Big middle message dropped
    expect(result).not.toContain(messages[2]); // Big middle message dropped
  });

  it("handles messages with complex content (tool results)", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me check." },
          { type: "tool_use", id: "1", name: "test", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "1",
            content: "result data",
            isError: false,
          },
        ],
      },
    ];

    const result = windowMessages(messages, 1000);
    expect(result).toHaveLength(3); // All fit
  });
});
