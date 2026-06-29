import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateFilesToRoom } from "../../scripts/migrate-files-to-room.ts";
import { workspaceFilesDir } from "../../src/files/paths.ts";
import { createFileStore } from "../../src/files/store.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";

/**
 * Round-trip coverage for the identity → workspace-owned file migration. Does
 * real filesystem I/O against a throwaway work-dir, hence `test/integration/`.
 */

const ALICE = "user_alice";
const BOB = "user_bob";

const ALICE_FILE_ID = `fl_${"a".repeat(24)}`;
const BOB_FILE_ID = `fl_${"b".repeat(24)}`;

/** Seed one file (blob + registry row) in a user's identity files dir. */
function seedIdentityFile(workDir: string, userId: string, fileId: string, body: string): void {
  const filesDir = join(workDir, "users", userId, "files");
  mkdirSync(filesDir, { recursive: true });
  const diskName = `${fileId}_doc.txt`;
  writeFileSync(join(filesDir, diskName), body, "utf-8");
  // A legacy registry row — no ownerId/workspaceId fields (the store backfills
  // them from the destination path on read).
  const row = {
    id: fileId,
    filename: "doc.txt",
    mimeType: "text/plain",
    size: Buffer.byteLength(body),
    tags: [],
    source: "chat",
    conversationId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    description: null,
  };
  writeFileSync(join(filesDir, "registry.jsonl"), `${JSON.stringify(row)}\n`, "utf-8");
}

/** The workspace-owned files dir for a user's personal workspace. */
function destFilesDir(workDir: string, userId: string): string {
  return workspaceFilesDir(workDir, personalWorkspaceIdFor(userId), userId);
}

describe("migrate-files-to-room", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-files-room-migrate-"));
    seedIdentityFile(workDir, ALICE, ALICE_FILE_ID, "alice secret");
    seedIdentityFile(workDir, BOB, BOB_FILE_ID, "bob secret");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("dry-run plans every move but writes nothing", () => {
    const summary = migrateFilesToRoom(workDir, { write: false });

    // Two files (blob + registry) per user × 2 users = 4 moves planned.
    expect(summary.moved).toBe(4);
    expect(summary.skippedExisting).toBe(0);
    expect(summary.users).toBe(2);

    // Nothing on disk changed: identity sources untouched, destinations absent.
    expect(existsSync(join(workDir, "users", ALICE, "files", "registry.jsonl"))).toBe(true);
    expect(existsSync(destFilesDir(workDir, ALICE))).toBe(false);
    expect(existsSync(join(workDir, ".migration-lock"))).toBe(false);
  });

  test("--write moves each user's files to their personal-workspace partition", () => {
    const summary = migrateFilesToRoom(workDir, { write: true });

    expect(summary.moved).toBe(4);
    expect(summary.users).toBe(2);

    // Files now live at workspaces/ws_user_<u>/files/<u>/.
    expect(existsSync(join(destFilesDir(workDir, ALICE), `${ALICE_FILE_ID}_doc.txt`))).toBe(true);
    expect(existsSync(join(destFilesDir(workDir, ALICE), "registry.jsonl"))).toBe(true);
    expect(existsSync(join(destFilesDir(workDir, BOB), `${BOB_FILE_ID}_doc.txt`))).toBe(true);

    // Identity sources are gone.
    expect(existsSync(join(workDir, "users", ALICE, "files", "registry.jsonl"))).toBe(false);
    expect(existsSync(join(workDir, "users", BOB, "files", `${BOB_FILE_ID}_doc.txt`))).toBe(false);

    expect(existsSync(join(workDir, ".migration-lock"))).toBe(false);
  });

  test("migrated files are readable, with scope backfilled from the path", async () => {
    migrateFilesToRoom(workDir, { write: true });

    const store = createFileStore(destFilesDir(workDir, ALICE));
    const entry = await store.findEntry(ALICE_FILE_ID);
    expect(entry).not.toBeNull();
    // The pure move carried no scope fields; the store backfills them from the
    // destination path.
    expect(entry?.ownerId).toBe(ALICE);
    expect(entry?.workspaceId).toBe(personalWorkspaceIdFor(ALICE));

    const read = await store.readFile(ALICE_FILE_ID);
    expect(read.data.toString("utf-8")).toBe("alice secret");
  });

  test("a file in user A's partition is not visible from user B's store", async () => {
    migrateFilesToRoom(workDir, { write: true });

    const bobStore = createFileStore(destFilesDir(workDir, BOB));
    // Bob's store never sees Alice's file — the partition is the wall.
    expect(await bobStore.findEntry(ALICE_FILE_ID)).toBeNull();
    const bobEntries = await bobStore.readRegistry();
    expect(bobEntries.map((e) => e.id)).toEqual([BOB_FILE_ID]);
  });

  test("a second --write run is idempotent (0 moves)", () => {
    migrateFilesToRoom(workDir, { write: true });
    const second = migrateFilesToRoom(workDir, { write: true });

    expect(second.moved).toBe(0);
    expect(second.skippedExisting).toBe(0);
    expect(second.users).toBe(0);
  });

  test("crash recovery: a pre-existing destination removes the stale identity source", () => {
    // Simulate a prior partial run: the dest registry exists, the identity
    // source was never unlinked.
    const aliceDest = destFilesDir(workDir, ALICE);
    mkdirSync(aliceDest, { recursive: true });
    const aliceSrcRegistry = join(workDir, "users", ALICE, "files", "registry.jsonl");
    writeFileSync(join(aliceDest, "registry.jsonl"), readFileSync(aliceSrcRegistry, "utf-8"));
    expect(existsSync(aliceSrcRegistry)).toBe(true);

    const summary = migrateFilesToRoom(workDir, { write: true });

    // Alice's registry counted as already-migrated; its stale source is removed.
    expect(summary.skippedExisting).toBe(1);
    expect(existsSync(aliceSrcRegistry)).toBe(false);
    // Alice's blob + both of Bob's files still move normally.
    expect(summary.moved).toBe(3);
  });
});
