/**
 * Conversation metadata schema — Stage 1 single-owner shape.
 *
 * Pre-Stage-1 this file exercised `visibility` and `participants`
 * field round-trips. Those fields are gone (delegation-model Stage 1);
 * the surviving canonical fields are `ownerId` (required) and
 * `workspaceId` (optional tool-scoping pointer).
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlConversationStore } from "../../src/conversation/jsonl-store.ts";
import { InMemoryConversationStore } from "../../src/conversation/memory-store.ts";

const testDir = join(tmpdir(), `nimblebrain-metadata-test-${Date.now()}`);
let testSeq = 0;

afterAll(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("Conversation metadata schema (JSONL)", () => {
  let store: JsonlConversationStore;
  let runDir: string;

  beforeEach(() => {
    runDir = join(testDir, `run-${++testSeq}`);
    store = new JsonlConversationStore(runDir);
  });

  it("creates a conversation with ownerId and workspaceId in JSONL line 1", async () => {
    const conv = await store.create({
      workspaceId: "ws_abc",
      ownerId: "user_123",
    });

    expect(conv.workspaceId).toBe("ws_abc");
    expect(conv.ownerId).toBe("user_123");
    // Stage 1: visibility + participants are gone from the schema.
    expect("visibility" in conv).toBe(false);
    expect("participants" in conv).toBe(false);

    const loaded = await store.load(conv.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.workspaceId).toBe("ws_abc");
    expect(loaded?.ownerId).toBe("user_123");
  });

  it("loading a pre-Stage-1 file without ownerId throws — operator must migrate", async () => {
    const conv = await store.create({ ownerId: "user_test" });

    // Hand-craft a legacy file by stripping the ownerId field.
    const path = join(runDir, `${conv.id}.jsonl`);
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n");
    const meta = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    delete meta.ownerId;
    lines[0] = JSON.stringify(meta);
    await writeFile(path, lines.join("\n"));

    // The store now throws a typed `ConversationCorruptedError` with
    // `reason: "missing_owner"` so the HTTP layer can map it to a
    // clean 422 with the migration command in the message.
    await expect(store.load(conv.id)).rejects.toThrow(/missing_owner/);
  });
});

describe("Conversation metadata schema (InMemory)", () => {
  let store: InMemoryConversationStore;

  beforeEach(() => {
    store = new InMemoryConversationStore();
  });

  it("creates with ownerId and workspaceId", async () => {
    const conv = await store.create({
      ownerId: "user_abc",
      workspaceId: "ws_xyz",
    });

    expect(conv.ownerId).toBe("user_abc");
    expect(conv.workspaceId).toBe("ws_xyz");
    expect("visibility" in conv).toBe(false);
    expect("participants" in conv).toBe(false);
  });

  it("creates without workspaceId — top-level conversation", async () => {
    const conv = await store.create({ ownerId: "user_abc" });

    expect(conv.ownerId).toBe("user_abc");
    expect(conv.workspaceId).toBeUndefined();
  });
});
