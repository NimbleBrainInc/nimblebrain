/**
 * Workspace-owned file store: the directory IS the wall. A store is rooted at one
 * owner's partition in one workspace (`workspaces/<wsId>/files/<ownerId>/`), so a file
 * saved there is physically absent from any other workspace's or owner's store —
 * `findEntry`/`readFile` return not-found with no code check required.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceFilesDir } from "../../../src/files/paths.ts";
import { createFileStore, type FileStore } from "../../../src/files/store.ts";
import type { FileEntry } from "../../../src/files/types.ts";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-files-workspace-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function store(wsId: string, ownerId: string): FileStore {
  return createFileStore(workspaceFilesDir(workDir, wsId, ownerId));
}

/** saveFile + register, the way the tool/ingest does, so the id is findable. */
async function put(s: FileStore, data = "hello"): Promise<string> {
  const saved = await s.saveFile(Buffer.from(data), "doc.txt", "text/plain");
  const entry: FileEntry = {
    id: saved.id,
    filename: "doc.txt",
    mimeType: "text/plain",
    size: saved.size,
    tags: [],
    source: "agent",
    conversationId: null,
    createdAt: "2026-06-25T00:00:00.000Z",
    description: null,
  };
  await s.appendRegistry(entry);
  return saved.id;
}

test("a file saved in workspace A is unreachable from workspace B's store", async () => {
  const storeA = store("ws_helix", "usr_alice");
  const id = await put(storeA);

  // Same workspace + owner → resolves.
  expect((await storeA.findEntry(id))?.id).toBe(id);
  expect((await storeA.readFile(id)).data.toString()).toBe("hello");

  // Different workspace (same owner) → the bytes aren't in that dir.
  const storeB = store("ws_acme", "usr_alice");
  expect(await storeB.findEntry(id)).toBeNull();
  await expect(storeB.readFile(id)).rejects.toThrow();
});

test("two owners in the same workspace are partitioned — neither sees the other's file", async () => {
  const alice = store("ws_helix", "usr_alice");
  const bob = store("ws_helix", "usr_bob");
  const aliceId = await put(alice);

  expect(await bob.findEntry(aliceId)).toBeNull();
  await expect(bob.readFile(aliceId)).rejects.toThrow();
});

test("each owner partition has its own registry (no cross-owner listing)", async () => {
  const alice = store("ws_helix", "usr_alice");
  const bob = store("ws_helix", "usr_bob");
  await put(alice, "alice-data");
  await put(bob, "bob-data");

  expect((await alice.readRegistry()).length).toBe(1);
  expect((await bob.readRegistry()).length).toBe(1);
});
