/**
 * `onMutate` is the only signal the tenant-wide conversation caches get, and
 * they now refresh **only what it names**. So the invariant under test is not
 * "writes are announced eventually" but "every write announces its own
 * conversation" — an unannounced write leaves an entry no unrelated traffic
 * will ever repair.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationMutation,
  EventSourcedConversationStore,
} from "../../../src/conversation/event-sourced-store.ts";
import type { ConversationEvent } from "../../../src/conversation/types.ts";

let dir: string;
let seen: ConversationMutation[];
let store: EventSourcedConversationStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nb-onmutate-"));
  mkdirSync(dir, { recursive: true });
  seen = [];
  store = new EventSourcedConversationStore({
    dir,
    onMutate: (change) => seen.push(change),
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A user-message event, the shape the event store actually persists. */
function userEvent(text: string): ConversationEvent {
  return {
    ts: new Date().toISOString(),
    type: "user.message",
    content: [{ type: "text", text }],
  } as ConversationEvent;
}

/** Announcements naming one conversation. */
function forId(id: string): ConversationMutation[] {
  return seen.filter((c) => c.id === id);
}

describe("EventSourcedConversationStore onMutate", () => {
  test("create announces the new conversation and its path", async () => {
    const conv = await store.create({ model: "anthropic:claude-sonnet-4-6", ownerId: "usr_a" });

    expect(forId(conv.id).length).toBeGreaterThan(0);
    expect(forId(conv.id)[0]!.filePath).toBe(join(dir, `${conv.id}.jsonl`));
  });

  test("append announces the conversation it appended to", async () => {
    const conv = await store.create({ model: "anthropic:claude-sonnet-4-6", ownerId: "usr_a" });
    seen = [];

    store.appendEvent!(conv.id, userEvent("hello"));

    expect(forId(conv.id).length).toBeGreaterThan(0);
  });

  test("update announces the conversation it patched", async () => {
    const conv = await store.create({ model: "anthropic:claude-sonnet-4-6", ownerId: "usr_a" });
    seen = [];

    await store.update(conv.id, { title: "Renamed" });

    expect(forId(conv.id).length).toBeGreaterThan(0);
  });

  test("delete announces the conversation it removed", async () => {
    const conv = await store.create({ model: "anthropic:claude-sonnet-4-6", ownerId: "usr_a" });
    seen = [];

    await store.delete(conv.id);

    expect(forId(conv.id).length).toBeGreaterThan(0);
  });

  test("every announcement names a path inside the store's own directory", async () => {
    const conv = await store.create({ model: "anthropic:claude-sonnet-4-6", ownerId: "usr_a" });
    store.appendEvent!(conv.id, userEvent("hello"));
    await store.update(conv.id, { title: "T" });
    await store.delete(conv.id);

    expect(seen.length).toBeGreaterThan(0);
    for (const change of seen) {
      expect(change.filePath).toBe(join(dir, `${change.id}.jsonl`));
    }
  });
});
