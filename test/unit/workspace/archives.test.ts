import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isArchiveName, listArchives, purgeArchive } from "../../../src/workspace/archives.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

let workDir: string;
let store: WorkspaceStore;
let archivedDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-archives-test-"));
  store = new WorkspaceStore(workDir);
  archivedDir = store.getArchivedDir();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function archiveOne(name: string): Promise<string> {
  const ws = await store.create(name);
  await writeFile(join(store.getWorkspacesDir(), ws.id, "data", "payload.bin"), "x".repeat(1000));
  await store.delete(ws.id);
  return ws.id;
}

describe("isArchiveName", () => {
  test("accepts the names delete produces", () => {
    expect(isArchiveName("ws_0123456789abcdef")).toBe(true);
    expect(isArchiveName("ws_user_usr_abc-1")).toBe(true);
    expect(isArchiveName("ws_team-v2")).toBe(true);
  });

  test("refuses anything that could leave archived/", () => {
    for (const name of [
      "",
      ".",
      "..",
      "../workspaces",
      "ws_a/../../workspaces",
      "ws_a/b",
      "ws_a\\b",
      "/etc",
      "ws_a-",
      "ws_a-..",
      "ws_a-b/c",
      "ws_a-b-c",
      "workspaces",
    ]) {
      expect(isArchiveName(name)).toBe(false);
    }
  });
});

describe("listArchives", () => {
  test("returns [] before anything has been archived", async () => {
    expect(await listArchives(archivedDir)).toEqual([]);
  });

  test("reads identity from workspace.json, size from the tree, time from the dir mtime", async () => {
    const id = await archiveOne("Alpha");

    const [row] = await listArchives(archivedDir);
    expect(row.name).toBe(id);
    expect(row.workspaceId).toBe(id);
    expect(row.workspaceName).toBe("Alpha");
    expect(row.sizeBytes).toBeGreaterThanOrEqual(1000);
    expect(row.archivedAt).toBe((await stat(join(archivedDir, id))).mtime.toISOString());
  });

  test("lists a directory with a missing or unparseable workspace.json as unknown", async () => {
    await archiveOne("Alpha");
    await mkdir(join(archivedDir, "ws_missing"), { recursive: true });
    await mkdir(join(archivedDir, "ws_broken"), { recursive: true });
    await writeFile(join(archivedDir, "ws_broken", "workspace.json"), "{not json");
    // A stray file is not an archive.
    await writeFile(join(archivedDir, "notes.txt"), "hello");

    const rows = await listArchives(archivedDir);
    expect(rows).toHaveLength(3);
    for (const name of ["ws_missing", "ws_broken"]) {
      const row = rows.find((r) => r.name === name);
      expect(row).toBeDefined();
      expect(row?.workspaceId).toBeNull();
      expect(row?.workspaceName).toBeNull();
    }
  });
});

describe("purgeArchive", () => {
  test("removes one archive and nothing else; a repeat is a no-op", async () => {
    const gone = await archiveOne("Alpha");
    const kept = await archiveOne("Beta");

    const first = await purgeArchive(archivedDir, gone);
    expect(first.purged).toBe(true);
    expect(first.sizeBytes).toBeGreaterThanOrEqual(1000);
    expect(existsSync(join(archivedDir, gone))).toBe(false);
    expect(existsSync(join(archivedDir, kept))).toBe(true);

    const second = await purgeArchive(archivedDir, gone);
    expect(second).toEqual({ purged: false, name: gone, sizeBytes: 0 });
    expect(existsSync(join(archivedDir, kept))).toBe(true);
  });

  test("cannot address anything outside archived/", async () => {
    await archiveOne("Alpha");
    const live = await store.create("Live");
    const liveDir = join(store.getWorkspacesDir(), live.id);

    for (const name of [
      `../workspaces/${live.id}`,
      "../workspaces",
      "..",
      `ws_x/../../workspaces/${live.id}`,
      liveDir,
    ]) {
      await expect(purgeArchive(archivedDir, name)).rejects.toThrow("is not an archive name");
    }
    expect(existsSync(liveDir)).toBe(true);
    expect(existsSync(archivedDir)).toBe(true);
  });

  test("refuses a symlink rather than following it", async () => {
    const outside = join(workDir, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep");
    await mkdir(archivedDir, { recursive: true });
    await symlink(outside, join(archivedDir, "ws_link"));

    await expect(purgeArchive(archivedDir, "ws_link")).rejects.toThrow("is not an archive directory");
    expect(existsSync(join(outside, "keep.txt"))).toBe(true);
  });
});
