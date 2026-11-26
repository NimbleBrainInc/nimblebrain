import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationEventStore, StoredMessage } from "../../src/conversation/types.ts";
import { conversationStore } from "../helpers/conversation-store.ts";

function tempDir(): string {
  const dir = join(tmpdir(), `nb-integration-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

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

// ---------------------------------------------------------------------------
// 1. Store-level full lifecycle: the runtime's store over the conversations
//    plugin, in process
// ---------------------------------------------------------------------------

describe("Conversation full lifecycle (store-level)", () => {
  let dir: string;
  let store: ConversationEventStore;

  beforeEach(() => {
    dir = tempDir();
    store = conversationStore(dir, "ws_0076759dbbe19fcc", "user_test");
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true });
  });

  it("create → append 3 messages → list (verify tokens) → rename → search → delete", async () => {
    // --- create ---
    const conv = await store.create({ model: "anthropic:claude-sonnet-4-6", ownerId: "user_test" });
    expect(conv.id).toMatch(/^conv_/);

    // --- append 3 messages ---
    await store.append(conv, msg("user", "Tell me about deployment pipelines"));
    await store.append(
      conv,
      assistantMsg("Deployment pipelines automate releases...", {
        usage: { inputTokens: 200, outputTokens: 80 },
        model: "anthropic:claude-sonnet-4-5-20250929",
      }),
    );
    await store.append(conv, msg("user", "Can you show me an example?"));

    // --- list and verify token accumulation (derived at read time) ---
    const listResult = await store.list();
    expect(listResult.totalCount).toBe(1);
    const summary = listResult.conversations[0]!;
    expect(summary.id).toBe(conv.id);
    expect(summary.totalInputTokens).toBe(200);
    expect(summary.totalOutputTokens).toBe(80);
    expect(summary.messageCount).toBe(3);

    // --- rename ---
    const updated = await store.update(conv.id, { title: "Deploy Pipeline Guide" });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Deploy Pipeline Guide");

    // verify title persists on reload
    const reloaded = await store.load(conv.id);
    expect(reloaded!.title).toBe("Deploy Pipeline Guide");

    // --- search ---
    const searchHit = await store.list({ search: "deploy" });
    expect(searchHit.conversations).toHaveLength(1);
    expect(searchHit.conversations[0]!.id).toBe(conv.id);

    const searchMiss = await store.list({ search: "quantum" });
    expect(searchMiss.conversations).toHaveLength(0);

    // history holds all 3 messages
    const originalHistory = await store.history(conv);
    expect(originalHistory).toHaveLength(3);

    // --- delete ---
    const deleted = await store.delete(conv.id);
    expect(deleted).toBe(true);

    // verify gone
    const afterDelete = await store.load(conv.id);
    expect(afterDelete).toBeNull();

    const afterDeleteList = await store.list();
    expect(afterDeleteList.totalCount).toBe(0);
  });
});
