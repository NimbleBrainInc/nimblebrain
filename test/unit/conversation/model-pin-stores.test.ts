/**
 * `CreateConversationOptions.model` is part of the `ConversationStore`
 * contract, so every implementation has to honor it — not just the one the
 * runtime happens to be typed to.
 *
 * The runtime only ever constructs `EventSourcedConversationStore`, so a store
 * that dropped the option would fail silently and invisibly. Both other stores
 * are exported from the package index, and both already honor `workspaceId`
 * through the identical spread; this keeps the two options symmetric.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

import { EventSourcedConversationStore } from "../../../src/conversation/event-sourced-store.ts";
import { JsonlConversationStore } from "../../../src/conversation/jsonl-store.ts";
import { InMemoryConversationStore } from "../../../src/conversation/memory-store.ts";
import type { ConversationStore } from "../../../src/conversation/types.ts";

const MODEL = "nebius:moonshotai/Kimi-K2.6";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nb-model-pin-stores-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const stores: Array<[string, () => ConversationStore]> = [
  ["EventSourcedConversationStore", () => new EventSourcedConversationStore({ dir: tempDir() })],
  ["JsonlConversationStore", () => new JsonlConversationStore(tempDir())],
  ["InMemoryConversationStore", () => new InMemoryConversationStore()],
];

describe.each(stores)("%s", (_name, make) => {
  test("create carries the model binding", async () => {
    const store = make();
    const conversation = await store.create({ ownerId: "usr_test", model: MODEL });
    expect(conversation.model).toBe(MODEL);

    // And it survives the round trip, since the binding is read back on every
    // turn rather than held in memory.
    const loaded = await store.load(conversation.id);
    expect(loaded?.model).toBe(MODEL);
  });

  test("create without a model leaves the conversation unpinned", async () => {
    const store = make();
    const conversation = await store.create({ ownerId: "usr_test" });
    // Absent, not null: absence is what marks a record as pre-binding, and
    // those resolve from current config.
    expect(conversation.model).toBeUndefined();
  });
});
