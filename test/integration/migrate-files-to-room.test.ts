import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { roomFilesDir } from "../../src/files/paths.ts";
import type { FileEntry } from "../../src/files/types.ts";
import { migrateFilesToRoom } from "../../scripts/migrate-files-to-room.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";

/**
 * Round-trip coverage for the identity → room-owned file migration. Does real
 * filesystem I/O against a throwaway work-dir, hence `test/integration/`.
 */

const OWNER = "u1";

/** File ids matching `fl_` + 24 hex (see `generateFileId` in src/files/store.ts). */
const FL_HELIX = "fl_000000000000000000000001";
const FL_PERSONAL = "fl_000000000000000000000002";
const FL_TOMB = "fl_000000000000000000000003";
const FL_MISSING = "fl_000000000000000000000004";

/** A complete FileEntry; callers override the few fields a case cares about. */
function entry(over: Partial<FileEntry> & { id: string; filename: string }): FileEntry {
  return {
    mimeType: "application/pdf",
    size: 3,
    tags: [],
    source: "chat",
    conversationId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    description: null,
    ...over,
  };
}

function userFilesDir(workDir: string): string {
  return join(workDir, "users", OWNER, "files");
}

/** Byte file disk name: `<id>_<filename>`, matching the store's scheme. */
function byteName(id: string, filename: string): string {
  return `${id}_${filename}`;
}

describe("migrate-files-to-room", () => {
  let workDir: string;

  // Source byte files.
  let helixByteSrc: string;
  let helixSidecarSrc: string;
  let personalByteSrc: string;

  // Destinations.
  let helixDir: string;
  let personalDir: string;
  let helixByteDest: string;
  let helixSidecarDest: string;
  let personalByteDest: string;
  let helixRegistry: string;
  let personalRegistry: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-files-room-migrate-"));
    const dir = userFilesDir(workDir);
    mkdirSync(dir, { recursive: true });

    // (a) explicit workspaceId → that room's owner partition; has a sidecar.
    const helixEntry = entry({ id: FL_HELIX, filename: "report.pdf", workspaceId: "ws_helix" });
    // (b) no workspaceId → the owner's personal workspace.
    const personalEntry = entry({ id: FL_PERSONAL, filename: "notes.txt", mimeType: "text/plain" });
    // (c) tombstone → copies through with no byte file (the delete must survive).
    const tombEntry = entry({ id: FL_TOMB, filename: "gone.txt", deleted: true });
    // (d) live entry whose byte file is missing on disk → un-migratable.
    const missingEntry = entry({ id: FL_MISSING, filename: "absent.txt" });

    writeFileSync(
      join(dir, "registry.jsonl"),
      `${[helixEntry, personalEntry, tombEntry, missingEntry].map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf-8",
    );

    // Bytes + sidecar for the two migratable live files (NOT the tombstone, NOT the missing one).
    helixByteSrc = join(dir, byteName(FL_HELIX, "report.pdf"));
    helixSidecarSrc = join(dir, `${FL_HELIX}.extracted.json`);
    personalByteSrc = join(dir, byteName(FL_PERSONAL, "notes.txt"));
    writeFileSync(helixByteSrc, Buffer.from("PDF"));
    writeFileSync(
      helixSidecarSrc,
      JSON.stringify({ text: "extracted", maxSize: 1000, truncated: false }),
      "utf-8",
    );
    writeFileSync(personalByteSrc, Buffer.from("txt"));

    helixDir = roomFilesDir(workDir, "ws_helix", OWNER);
    personalDir = roomFilesDir(workDir, personalWorkspaceIdFor(OWNER), OWNER);
    helixByteDest = join(helixDir, byteName(FL_HELIX, "report.pdf"));
    helixSidecarDest = join(helixDir, `${FL_HELIX}.extracted.json`);
    personalByteDest = join(personalDir, byteName(FL_PERSONAL, "notes.txt"));
    helixRegistry = join(helixDir, "registry.jsonl");
    personalRegistry = join(personalDir, "registry.jsonl");
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("dry-run plans every move but writes nothing", () => {
    const summary = migrateFilesToRoom(workDir, { write: false });

    expect(summary.moved).toBe(3); // helix bytes, personal bytes, tombstone record
    expect(summary.skippedMissingBytes).toBe(1);
    expect(summary.skippedExisting).toBe(0);

    // Sources untouched, destinations absent, no lock left behind.
    expect(existsSync(helixByteSrc)).toBe(true);
    expect(existsSync(personalByteSrc)).toBe(true);
    expect(existsSync(helixDir)).toBe(false);
    expect(existsSync(personalDir)).toBe(false);
    expect(existsSync(join(workDir, ".migration-lock"))).toBe(false);
  });

  test("--write moves bytes + sidecar to the exact room-owned path and stamps the entry", () => {
    const summary = migrateFilesToRoom(workDir, { write: true });

    expect(summary.moved).toBe(3);
    expect(summary.skippedMissingBytes).toBe(1);

    // Bytes + sidecar now live at the precise paths roomFilesDir computes.
    expect(existsSync(helixByteDest)).toBe(true);
    expect(existsSync(helixSidecarDest)).toBe(true);
    expect(existsSync(personalByteDest)).toBe(true);
    expect(readFileSync(helixByteDest).toString()).toBe("PDF");

    // Source bytes/sidecar for migrated files are gone.
    expect(existsSync(helixByteSrc)).toBe(false);
    expect(existsSync(helixSidecarSrc)).toBe(false);
    expect(existsSync(personalByteSrc)).toBe(false);

    // The dest registry has the helix entry stamped with owner + room.
    const helixEntries = readFileSync(helixRegistry, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as FileEntry);
    const helix = helixEntries.find((e) => e.id === FL_HELIX);
    expect(helix?.ownerId).toBe(OWNER);
    expect(helix?.workspaceId).toBe("ws_helix");

    // The tombstone survives in the personal-room registry.
    const personalEntries = readFileSync(personalRegistry, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as FileEntry);
    const tomb = personalEntries.find((e) => e.id === FL_TOMB);
    expect(tomb?.deleted).toBe(true);
    expect(tomb?.ownerId).toBe(OWNER);

    // No temp/lock residue.
    expect(existsSync(join(workDir, ".migration-lock"))).toBe(false);
  });

  test("a second --write run is idempotent (0 moves)", () => {
    migrateFilesToRoom(workDir, { write: true });
    const second = migrateFilesToRoom(workDir, { write: true });

    expect(second.moved).toBe(0);
    expect(second.skippedExisting).toBe(3); // helix, personal, tombstone
    // The missing-byte entry is still un-migratable.
    expect(second.skippedMissingBytes).toBe(1);

    // Destinations are intact (not duplicated).
    expect(existsSync(helixByteDest)).toBe(true);
    expect(existsSync(personalByteDest)).toBe(true);
  });

  // A legacy-scheme id (`fl_<base36>_<8hex>`) is still served by the runtime, so
  // the migration MUST move it — a stricter gate would skip it and orphan the
  // file (and every persisted `files://fl_<legacy>` link) on cutover.
  test("migrates a legacy-format file id (not skipped as invalid)", () => {
    const legacyId = "fl_m3k2x9_deadbeef";
    const legacyDir = mkdtempSync(join(tmpdir(), "nb-files-legacy-"));
    try {
      const dir = userFilesDir(legacyDir);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "registry.jsonl"),
        `${JSON.stringify(entry({ id: legacyId, filename: "old.txt", mimeType: "text/plain" }))}\n`,
        "utf-8",
      );
      writeFileSync(join(dir, byteName(legacyId, "old.txt")), Buffer.from("legacy"));

      const summary = migrateFilesToRoom(legacyDir, { write: true });
      expect(summary.skippedInvalidId).toBe(0);
      expect(summary.moved).toBe(1);

      const dest = join(roomFilesDir(legacyDir, personalWorkspaceIdFor(OWNER), OWNER), byteName(legacyId, "old.txt"));
      expect(existsSync(dest)).toBe(true);
      expect(readFileSync(dest).toString()).toBe("legacy");
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
