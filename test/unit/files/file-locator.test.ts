/**
 * Unit tests for the process-wide FileLocator.
 *
 * Pins the contract the bare `GET /v1/files/:fileId` serve path rests on:
 * resolution is owner-scoped (the search scope is the gate), globally-unique
 * ids resolve to at most one workspace (a dup is refused, not guessed), and the
 * memo is an optimization the disk walk overrides.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLocator } from "../../../src/files/locator.ts";
import { workspaceFilesDir } from "../../../src/files/paths.ts";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "nb-file-locator-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let fileCounter = 0;
function fileId(): string {
  fileCounter += 1;
  return `fl_${fileCounter.toString(16).padStart(24, "0")}`;
}

/** Write a file's bytes into an owner's partition (the locator only reads the path). */
function writeFile(wsId: string, ownerId: string, id: string, name = "image.png"): void {
  const dir = workspaceFilesDir(workDir, wsId, ownerId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}_${name}`), "bytes");
}

function locator(): FileLocator {
  return new FileLocator(workDir);
}

test("locate resolves a file id to the workspace it lives in", async () => {
  const id = fileId();
  writeFile("ws_helix", "usr_alice", id);

  expect(await locator().resolve("usr_alice", id)).toBe("ws_helix");
});

test("locate returns undefined for an unknown id (→ 404)", async () => {
  expect(await locator().resolve("usr_alice", fileId())).toBeUndefined();
});

test("owner-scope wall: another owner's file is invisible", async () => {
  // The search scope IS the gate — locate only ever walks the caller's own
  // `<ownerId>` partitions, so a file owned by someone else never resolves.
  const id = fileId();
  writeFile("ws_helix", "usr_bob", id);

  expect(await locator().resolve("usr_alice", id)).toBeUndefined();
});

test("resolves by path alone — never reads file content", async () => {
  // The bytes are irrelevant to resolution; an empty file still resolves,
  // because locate only matches the `<fileId>_*` filename in the owner's dir.
  const id = fileId();
  const dir = workspaceFilesDir(workDir, "ws_helix", "usr_alice");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}_anything`), "");

  expect(await locator().resolve("usr_alice", id)).toBe("ws_helix");
});

test("duplicate id across two workspaces is refused, not guessed", async () => {
  // File ids are globally unique; if one somehow lands in two of an owner's
  // partitions, resolution is ambiguous → not-found, never a coin flip.
  const id = fileId();
  writeFile("ws_helix", "usr_alice", id);
  writeFile("ws_acme", "usr_alice", id);

  expect(await locator().resolve("usr_alice", id)).toBeUndefined();
});

test("remember populates the memo; peek serves it without touching disk", async () => {
  const loc = locator();
  const id = fileId();
  loc.remember("usr_alice", id, "ws_helix"); // nothing on disk

  expect(loc.peek("usr_alice", id)).toBe("ws_helix");
});

test("forget drops the memo entry", async () => {
  const loc = locator();
  const id = fileId();
  loc.remember("usr_alice", id, "ws_helix");
  loc.forget("usr_alice", id);

  // No disk entry and no memo → nothing to peek, nothing to resolve.
  expect(loc.peek("usr_alice", id)).toBeUndefined();
  expect(await loc.resolve("usr_alice", id)).toBeUndefined();
});

test("memo is owner-scoped: one owner can't peek or evict another's entry", async () => {
  // Keyed by (ownerId, fileId), not the id alone — so a request for someone
  // else's id neither reads their cached workspace nor drops their entry.
  const loc = locator();
  const id = fileId();
  loc.remember("usr_bob", id, "ws_helix");

  expect(loc.peek("usr_alice", id)).toBeUndefined(); // not visible to alice
  loc.forget("usr_alice", id); // alice's forget must not touch bob's entry
  expect(loc.peek("usr_bob", id)).toBe("ws_helix"); // bob's entry intact
});
