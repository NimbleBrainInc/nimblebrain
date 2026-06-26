/**
 * Unit tests for the process-wide ConversationLocator.
 *
 * Pins the room-owned storage contract: the path is the wall (room filter),
 * ownership is the access gate; resolution and both list views come from one
 * structure; freshness is invalidate-on-write + JIT rescan (no fs.watch).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationLocator } from "../../../src/conversation/locator.ts";
import { roomConversationsDir, runConversationsDir } from "../../../src/conversation/paths.ts";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-locator-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let convCounter = 0;
function convId(): string {
  convCounter += 1;
  return `conv_${convCounter.toString(16).padStart(16, "0")}`;
}

/** Write a minimal valid event-sourced conversation file into a room dir. */
function writeConversation(dir: string, id: string, ownerId: string, wsId: string): void {
  mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    title: null,
    ownerId,
    workspaceId: wsId,
    format: "events",
  };
  writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify(meta)}\n`);
}

function locator(): ConversationLocator {
  return new ConversationLocator(join(workDir, "workspaces"));
}

test("locate resolves a conversation to its room + owner", async () => {
  const id = convId();
  writeConversation(roomConversationsDir(workDir, "ws_helix", "usr_alice"), id, "usr_alice", "ws_helix");

  const loc = await locator().locate(id);
  expect(loc).toBeDefined();
  expect(loc?.wsId).toBe("ws_helix");
  expect(loc?.ownerId).toBe("usr_alice");
  expect(loc?.automationId).toBeNull();
});

test("locate returns undefined for an unknown id", async () => {
  expect(await locator().locate("conv_ffffffffffffffff")).toBeUndefined();
});

test("an automation-run conversation resolves with its automationId, ownerId null", async () => {
  const id = convId();
  writeConversation(runConversationsDir(workDir, "ws_helix", "auto_x"), id, "usr_alice", "ws_helix");

  const loc = await locator().locate(id);
  expect(loc?.wsId).toBe("ws_helix");
  expect(loc?.automationId).toBe("auto_x");
  expect(loc?.ownerId).toBeNull();
});

test("room-scoped list returns only the focused room; all-rooms returns every room", async () => {
  const helix = convId();
  const acme = convId();
  writeConversation(roomConversationsDir(workDir, "ws_helix", "usr_alice"), helix, "usr_alice", "ws_helix");
  writeConversation(roomConversationsDir(workDir, "ws_acme", "usr_alice"), acme, "usr_alice", "ws_acme");

  const loc = locator();
  const access = { userId: "usr_alice" };

  const roomScoped = await loc.list({ workspaceId: "ws_helix" }, access);
  expect(roomScoped.conversations.map((c) => c.id)).toEqual([helix]);

  const allRooms = await loc.list({}, access);
  expect(allRooms.conversations.map((c) => c.id).sort()).toEqual([helix, acme].sort());
});

test("the access gate hides another owner's conversation in the same room", async () => {
  const mine = convId();
  const theirs = convId();
  const dirAlice = roomConversationsDir(workDir, "ws_helix", "usr_alice");
  const dirBob = roomConversationsDir(workDir, "ws_helix", "usr_bob");
  writeConversation(dirAlice, mine, "usr_alice", "ws_helix");
  writeConversation(dirBob, theirs, "usr_bob", "ws_helix");

  const loc = locator();
  const aliceList = await loc.list({ workspaceId: "ws_helix" }, { userId: "usr_alice" });
  expect(aliceList.conversations.map((c) => c.id)).toEqual([mine]);

  // Alice cannot resolve-then-read Bob's conversation: locate finds the path,
  // but the room store's load(access) is what enforces ownership. Here we only
  // assert the list (the access gate) hides it.
  expect(aliceList.conversations.find((c) => c.id === theirs)).toBeUndefined();
});

test("invalidate + JIT rescan picks up a newly written conversation (no fs.watch)", async () => {
  const loc = locator();
  const first = convId();
  writeConversation(roomConversationsDir(workDir, "ws_helix", "usr_alice"), first, "usr_alice", "ws_helix");

  // Cold read populates.
  expect((await loc.list({}, { userId: "usr_alice" })).totalCount).toBe(1);

  // Write a second file directly (simulating another store), then invalidate.
  const second = convId();
  writeConversation(roomConversationsDir(workDir, "ws_helix", "usr_alice"), second, "usr_alice", "ws_helix");
  // Without invalidate the cache is stale...
  expect((await loc.list({}, { userId: "usr_alice" })).totalCount).toBe(1);
  // ...invalidate forces a rescan on the next read.
  loc.invalidate();
  expect((await loc.list({}, { userId: "usr_alice" })).totalCount).toBe(2);
});

test("an ownerless conversation file is excluded from the index", async () => {
  const id = convId();
  const dir = roomConversationsDir(workDir, "ws_helix", "usr_alice");
  mkdirSync(dir, { recursive: true });
  // Line-1 metadata with no ownerId — pre-migration shape.
  writeFileSync(
    join(dir, `${id}.jsonl`),
    `${JSON.stringify({ id, createdAt: "2026-06-25T00:00:00.000Z", format: "events" })}\n`,
  );

  expect(await locator().locate(id)).toBeUndefined();
});
