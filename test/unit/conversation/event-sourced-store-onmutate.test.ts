/**
 * `onMutate` is the only signal the tenant-wide conversation caches get, and
 * they now refresh **only what it names**. So the invariant under test is not
 * "writes are announced eventually" but "every write announces its own
 * conversation" — an unannounced write leaves an entry no unrelated traffic
 * will ever repair.
 *
 * The fork case is the one that motivated this file: `fork()` writes twice, and
 * only the second write carries the messages.
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
    const conv = await store.create({ ownerId: "usr_a" });

    expect(forId(conv.id).length).toBeGreaterThan(0);
    expect(forId(conv.id)[0]!.filePath).toBe(join(dir, `${conv.id}.jsonl`));
  });

  test("append announces the conversation it appended to", async () => {
    const conv = await store.create({ ownerId: "usr_a" });
    seen = [];

    store.appendEvent!(conv.id, userEvent("hello"));

    expect(forId(conv.id).length).toBeGreaterThan(0);
  });

  test("update announces the conversation it patched", async () => {
    const conv = await store.create({ ownerId: "usr_a" });
    seen = [];

    await store.update(conv.id, { title: "Renamed" });

    expect(forId(conv.id).length).toBeGreaterThan(0);
  });

  test("delete announces the conversation it removed", async () => {
    const conv = await store.create({ ownerId: "usr_a" });
    seen = [];

    await store.delete(conv.id);

    expect(forId(conv.id).length).toBeGreaterThan(0);
  });

  test("fork announces the copy AFTER its messages are written", async () => {
    const source = await store.create({ ownerId: "usr_a" });
    store.appendEvent!(source.id, userEvent("one"));
    store.appendEvent!(source.id, userEvent("two"));
    seen = [];

    const forked = await store.fork(source.id);
    expect(forked).not.toBeNull();

    // `create()` inside `fork()` announces an EMPTY conversation. The messages
    // arrive in a second write, so the last announcement for the fork must come
    // after that write — otherwise a listener that refreshed on the first one
    // caches a 0-message fork forever. Reading the file at the moment of the
    // final announcement is what pins the ordering, not the count.
    const announcements = forId(forked!.id);
    expect(announcements.length).toBeGreaterThanOrEqual(2);

    // The fork really did carry messages across, so the second announcement is
    // reporting a state the first one could not have.
    const sourceHistory = await store.history(source);
    const forkedHistory = await store.history(forked!);
    expect(forkedHistory.length).toBe(sourceHistory.length);
    expect(forkedHistory.length).toBeGreaterThan(0);
  });

  test("every announcement names a path inside the store's own directory", async () => {
    const conv = await store.create({ ownerId: "usr_a" });
    store.appendEvent!(conv.id, userEvent("hello"));
    await store.update(conv.id, { title: "T" });
    await store.fork(conv.id);
    await store.delete(conv.id);

    expect(seen.length).toBeGreaterThan(0);
    for (const change of seen) {
      expect(change.filePath).toBe(join(dir, `${change.id}.jsonl`));
    }
  });
});
