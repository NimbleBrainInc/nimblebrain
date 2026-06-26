import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ARCHIVE_MARKER_FILENAME,
  type ArchiveMarker,
  WorkspaceStore,
} from "../../src/workspace/workspace-store.ts";

// Archive-then-cascade delete (SPEC-permission-boundaries §2.3): deleting a
// workspace must tombstone its data subtree under `archived/<wsId>/` —
// recoverable/exportable for a retention window — rather than hard-`rm` it.
// These are filesystem-level assertions (the subtree MOVED, not vanished),
// hence an integration test.

let workDir: string;
let store: WorkspaceStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ws-archive-test-"));
  store = new WorkspaceStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const wsDirPath = (id: string) => join(workDir, "workspaces", id);
const archiveDirPath = (id: string) => join(workDir, "archived", id);

describe("WorkspaceStore.delete — archive-then-cascade", () => {
  test("moves the workspace subtree to archived/ instead of destroying it", async () => {
    const ws = await store.create("To Archive");

    // Drop a sentinel deep in the subtree. If delete hard-`rm`'d and the
    // archive were recreated empty, this file would be gone — its survival
    // under archived/ is the proof the subtree was MOVED, not deleted.
    const sentinelRel = join("files", "sentinel.txt");
    await writeFile(join(wsDirPath(ws.id), sentinelRel), "keep-me", "utf-8");

    expect(existsSync(wsDirPath(ws.id))).toBe(true);

    const deleted = await store.delete(ws.id);
    expect(deleted).toBe(true);

    // (a) The live subtree under workspaces/ is gone.
    expect(existsSync(wsDirPath(ws.id))).toBe(false);

    // (b) The subtree now lives under archived/ — with the sentinel intact,
    //     the original workspace.json, and the tombstone marker.
    expect(existsSync(archiveDirPath(ws.id))).toBe(true);
    expect(await readFile(join(archiveDirPath(ws.id), sentinelRel), "utf-8")).toBe("keep-me");
    expect(existsSync(join(archiveDirPath(ws.id), "workspace.json"))).toBe(true);

    const marker = JSON.parse(
      await readFile(join(archiveDirPath(ws.id), ARCHIVE_MARKER_FILENAME), "utf-8"),
    ) as ArchiveMarker;
    expect(marker).toEqual({ wsId: ws.id, archivedReason: "workspace_deleted" });

    // (c) The store no longer returns or lists the workspace.
    expect(await store.get(ws.id)).toBeNull();
    expect((await store.list()).map((w) => w.id)).not.toContain(ws.id);
  });

  test("getArchivedDir points at the tombstone root holding the archive", async () => {
    const ws = await store.create("Located By Operator");
    await store.delete(ws.id);

    expect(store.getArchivedDir()).toBe(join(workDir, "archived"));
    expect(existsSync(join(store.getArchivedDir(), ws.id, ARCHIVE_MARKER_FILENAME))).toBe(true);
  });

  test("returns false (no archive) for a workspace that does not exist", async () => {
    expect(await store.delete("ws_ghost")).toBe(false);
    expect(existsSync(archiveDirPath("ws_ghost"))).toBe(false);
  });

  test("disambiguates a same-id re-archive via a deterministic counter", async () => {
    // Explicit slug → deterministic id, so the re-created workspace reuses
    // the same id (the real-world case: a personal ws_user_* deleted, the
    // user returns, a fresh personal workspace is created, then deleted).
    const slug = "user_alice";
    const first = await store.create("Alice", slug);
    await store.delete(first.id);
    expect(existsSync(archiveDirPath(first.id))).toBe(true);

    const second = await store.create("Alice Again", slug);
    expect(second.id).toBe(first.id);
    await store.delete(second.id);

    // First archive untouched; the second lands beside it under a counter
    // suffix rather than clobbering it.
    expect(existsSync(archiveDirPath(first.id))).toBe(true);
    expect(existsSync(join(workDir, "archived", `${first.id}-1`))).toBe(true);
    expect(
      existsSync(join(workDir, "archived", `${first.id}-1`, ARCHIVE_MARKER_FILENAME)),
    ).toBe(true);
  });

  test("honors a caller-supplied archiveSuffix on collision", async () => {
    const slug = "user_bob";
    const first = await store.create("Bob", slug);
    await store.delete(first.id);

    const second = await store.create("Bob Again", slug);
    await store.delete(second.id, { archiveSuffix: "v2" });

    expect(existsSync(join(workDir, "archived", `${first.id}-v2`))).toBe(true);
    const marker = JSON.parse(
      await readFile(
        join(workDir, "archived", `${first.id}-v2`, ARCHIVE_MARKER_FILENAME),
        "utf-8",
      ),
    ) as ArchiveMarker;
    expect(marker.wsId).toBe(first.id);
  });
});
