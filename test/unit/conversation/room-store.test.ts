/**
 * Per-room conversation store: the directory IS the wall.
 *
 * Each `EventSourcedConversationStore` is bound to one
 * `workspaces/<wsId>/conversations/<ownerId>` dir. A conversation born in room A
 * is physically absent from room B's dir, so loading it through room B's store
 * returns null — no code check required, the path enforces it. Also pins the
 * `onMutate` hook the runtime uses to invalidate the cross-room locator.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventSourcedConversationStore } from "../../../src/conversation/event-sourced-store.ts";
import { roomConversationsDir } from "../../../src/conversation/paths.ts";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-room-store-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function roomStore(wsId: string, ownerId: string, onMutate?: () => void): EventSourcedConversationStore {
  return new EventSourcedConversationStore({
    dir: roomConversationsDir(workDir, wsId, ownerId),
    ...(onMutate ? { onMutate } : {}),
  });
}

test("a conversation born in room A is unreachable through room B's store", async () => {
  const roomA = roomStore("ws_helix", "usr_alice");
  const conv = await roomA.create({ ownerId: "usr_alice", workspaceId: "ws_helix" });

  // Same room, same owner → loads.
  expect(await roomA.load(conv.id)).not.toBeNull();

  // Different room (same owner) → the file isn't in that dir, so null. The path
  // is the wall: a chat that hops rooms cannot carry its context across.
  const roomB = roomStore("ws_acme", "usr_alice");
  expect(await roomB.load(conv.id)).toBeNull();
});

test("two owners in the same room are physically partitioned", async () => {
  const alice = roomStore("ws_helix", "usr_alice");
  const bob = roomStore("ws_helix", "usr_bob");
  const aliceConv = await alice.create({ ownerId: "usr_alice", workspaceId: "ws_helix" });

  // Bob's store (a different `<ownerId>/` sub-partition) never sees Alice's file.
  expect(await bob.load(aliceConv.id)).toBeNull();
});

test("onMutate fires on create, append, and delete (cache invalidation hook)", async () => {
  let mutations = 0;
  const store = roomStore("ws_helix", "usr_alice", () => {
    mutations += 1;
  });

  const conv = await store.create({ ownerId: "usr_alice", workspaceId: "ws_helix" });
  expect(mutations).toBe(1);

  // An append changes the conversation's summary, so it must invalidate the
  // caches too — this is the fix for the frozen-list-summary regression.
  store.appendEvent(conv.id, {
    ts: "2026-06-25T00:00:00.000Z",
    type: "metadata.title",
    title: "Renamed",
  });
  expect(mutations).toBe(2);

  await store.delete(conv.id);
  expect(mutations).toBe(3);
});

test("the conversation records its bound room as workspaceId", async () => {
  const store = roomStore("ws_helix", "usr_alice");
  const conv = await store.create({ ownerId: "usr_alice", workspaceId: "ws_helix" });
  expect(conv.workspaceId).toBe("ws_helix");
});
