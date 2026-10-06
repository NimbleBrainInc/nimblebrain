/**
 * `CreateConversationOptions.model` is part of the `ConversationStore`
 * contract, so every implementation has to honor it — not just the one the
 * runtime happens to be typed to.
 *
 * The runtime only ever constructs `EventSourcedConversationStore`, so a store
 * that dropped the option would fail silently and invisibly. The in-memory
 * store is exported from the package index and already honors `workspaceId`
 * through the identical spread; this keeps the two options symmetric.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventSourcedConversationStore } from "../../../src/conversation/event-sourced-store.ts";
import { InMemoryConversationStore } from "../../../src/conversation/memory-store.ts";
import type { ConversationStore } from "../../../src/conversation/types.ts";
import { ConversationCorruptedError } from "../../../src/runtime/errors.ts";

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

  test("a fork inherits the binding", async () => {
    // A fork continues the source conversation; re-resolving would replay its
    // history to whatever the default is now.
    const store = make();
    const source = await store.create({ ownerId: "usr_test", model: MODEL });
    const fork = await store.fork(source.id);
    expect(fork?.model).toBe(MODEL);
  });
});

describe("EventSourcedConversationStore — a header without a model", () => {
  test("is refused as conversation_corrupted, not run unbound", async () => {
    const dir = tempDir();
    const store = new EventSourcedConversationStore({ dir });
    const conversation = await store.create({ ownerId: "usr_test", model: MODEL });
    const path = join(dir, `${conversation.id}.jsonl`);
    const [header, ...rest] = readFileSync(path, "utf8").split("\n");
    const { model: _model, ...unbound } = JSON.parse(header as string);
    writeFileSync(path, [JSON.stringify(unbound), ...rest].join("\n"));

    const error = await store.load(conversation.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConversationCorruptedError);
    expect((error as ConversationCorruptedError).reason).toBe("missing_model");
  });
});
