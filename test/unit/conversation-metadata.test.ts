import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlConversationStore } from "../../src/conversation/jsonl-store.ts";
import { InMemoryConversationStore } from "../../src/conversation/memory-store.ts";
import type { StoredMessage } from "../../src/conversation/types.ts";

function msg(role: "user" | "assistant", content: string, userId?: string): StoredMessage {
  return { role, content, timestamp: new Date().toISOString(), ...(userId ? { userId } : {}) };
}

const testDir = join(tmpdir(), `nimblebrain-metadata-test-${Date.now()}`);
let testSeq = 0;

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("Conversation metadata extensions (JSONL)", () => {
  let store: JsonlConversationStore;

  beforeEach(() => {
    store = new JsonlConversationStore(join(testDir, `run-${++testSeq}`));
  });

  it("creates a conversation with ownerId and workspaceId in JSONL line 1", async () => {
    const conv = await store.create({
      workspaceId: "ws_abc",
      ownerId: "user_123",
    });

    expect(conv.workspaceId).toBe("ws_abc");
    expect(conv.ownerId).toBe("user_123");
    expect(conv.visibility).toBe("private");
    expect(conv.participants).toEqual(["user_123"]);

    // Verify the raw JSONL line 1
    const dir = join(testDir, `run-${Date.now() - 1}`);
    // Read via load to confirm round-trip
    const loaded = await store.load(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.workspaceId).toBe("ws_abc");
    expect(loaded!.ownerId).toBe("user_123");
    expect(loaded!.visibility).toBe("private");
    expect(loaded!.participants).toEqual(["user_123"]);
  });

  it("writes new fields to JSONL line 1 on disk", async () => {
    const conv = await store.create({
      workspaceId: "ws_disk",
      ownerId: "user_disk",
      visibility: "shared",
      participants: ["user_disk", "user_other"],
    });

    // Read raw file to verify JSONL format
    const jsonlFile = `${conv.id}.jsonl`;

    const raw = await readFile(join((store as any).dir, jsonlFile), "utf-8");
    const line1 = JSON.parse(raw.split("\n")[0]);

    expect(line1.workspaceId).toBe("ws_disk");
    expect(line1.ownerId).toBe("user_disk");
    expect(line1.visibility).toBe("shared");
    expect(line1.participants).toEqual(["user_disk", "user_other"]);
  });

  it("defaults visibility to private when ownerId is provided", async () => {
    const conv = await store.create({ ownerId: "user_456" });
    expect(conv.visibility).toBe("private");
    expect(conv.participants).toEqual(["user_456"]);
  });

  it("creates conversation without new fields (backward compat)", async () => {
    const conv = await store.create();
    expect(conv.workspaceId).toBeUndefined();
    expect(conv.ownerId).toBeUndefined();
    expect(conv.visibility).toBeUndefined();
    expect(conv.participants).toBeUndefined();
  });

  it("loads a legacy conversation without new fields gracefully", async () => {
    // Create a conversation without new fields (simulates legacy)
    const conv = await store.create();
    const loaded = await store.load(conv.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.workspaceId).toBeUndefined();
    expect(loaded!.ownerId).toBeUndefined();
    expect(loaded!.visibility).toBeUndefined();
    expect(loaded!.participants).toBeUndefined();
    // Core fields still work
    expect(loaded!.id).toBe(conv.id);
    expect(loaded!.createdAt).toBeTruthy();
  });

  it("serializes and deserializes message with userId", async () => {
    const conv = await store.create({ ownerId: "user_a" });

    const userMsg = msg("user", "Hello from user A", "user_a");
    await store.append(conv, userMsg);

    const assistantMsg = msg("assistant", "Hi there");
    await store.append(conv, assistantMsg);

    const history = await store.history(conv);
    expect(history).toHaveLength(2);
    expect(history[0]!.userId).toBe("user_a");
    expect(history[1]!.userId).toBeUndefined();
  });

  it("preserves new metadata fields through append", async () => {
    const conv = await store.create({
      workspaceId: "ws_persist",
      ownerId: "user_persist",
    });

    await store.append(conv, msg("user", "Hello"));
    await store.append(conv, msg("assistant", "Hi"));

    // Reload and verify metadata survived
    const loaded = await store.load(conv.id);
    expect(loaded!.workspaceId).toBe("ws_persist");
    expect(loaded!.ownerId).toBe("user_persist");
    expect(loaded!.visibility).toBe("private");
    expect(loaded!.participants).toEqual(["user_persist"]);
  });

  it("preserves new metadata fields through update", async () => {
    const conv = await store.create({
      workspaceId: "ws_update",
      ownerId: "user_update",
    });

    await store.update(conv.id, { title: "Updated title" });
    await store.flush();

    const loaded = await store.load(conv.id);
    expect(loaded!.title).toBe("Updated title");
    expect(loaded!.workspaceId).toBe("ws_update");
    expect(loaded!.ownerId).toBe("user_update");
  });

  it("lists conversations with new metadata fields", async () => {
    const freshStore = new JsonlConversationStore(join(testDir, `list-${Date.now()}`));
    await freshStore.create({ workspaceId: "ws_list", ownerId: "user_list" });
    await freshStore.create(); // no metadata

    const result = await freshStore.list();
    expect(result.totalCount).toBe(2);
  });

  it("fork preserves source conversation operations", async () => {
    const conv = await store.create({ workspaceId: "ws_fork", ownerId: "user_fork" });
    await store.append(conv, msg("user", "First"));
    await store.append(conv, msg("assistant", "Response"));

    const forked = await store.fork(conv.id);
    expect(forked).not.toBeNull();

    const history = await store.history(forked!);
    expect(history).toHaveLength(2);
    expect(history[0]!.content).toBe("First");
  });
});

describe("Conversation metadata extensions (InMemory)", () => {
  let store: InMemoryConversationStore;

  beforeEach(() => {
    store = new InMemoryConversationStore();
  });

  it("creates with ownerId/workspaceId", async () => {
    const conv = await store.create({
      workspaceId: "ws_mem",
      ownerId: "user_mem",
    });

    expect(conv.workspaceId).toBe("ws_mem");
    expect(conv.ownerId).toBe("user_mem");
    expect(conv.visibility).toBe("private");
    expect(conv.participants).toEqual(["user_mem"]);
  });

  it("creates without new fields", async () => {
    const conv = await store.create();
    expect(conv.workspaceId).toBeUndefined();
    expect(conv.ownerId).toBeUndefined();
    expect(conv.visibility).toBeUndefined();
    expect(conv.participants).toBeUndefined();
  });

  it("stores and retrieves message userId", async () => {
    const conv = await store.create({ ownerId: "user_x" });
    await store.append(conv, msg("user", "Test", "user_x"));

    const history = await store.history(conv);
    expect(history[0]!.userId).toBe("user_x");
  });
});
