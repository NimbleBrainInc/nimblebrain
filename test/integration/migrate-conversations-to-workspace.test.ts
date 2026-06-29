import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  workspaceConversationsDir,
  runConversationsDir,
} from "../../src/conversation/paths.ts";
import { migrateConversationsToWorkspace } from "../../scripts/migrate-conversations-to-workspace.ts";
import { personalWorkspaceIdFor } from "../../src/workspace/workspace-store.ts";

/**
 * Round-trip coverage for the flat → workspace-owned conversation migration. Does
 * real filesystem I/O against a throwaway work-dir, hence `test/integration/`.
 */

const OWNER = "user_alice";
const OTHER_OWNER = "user_bob";

/** A conv id matching `CONVERSATION_ID_RE` (conv_ + 16 hex). */
const CONV_HELIX = "conv_0000000000000001";
const CONV_PERSONAL = "conv_0000000000000002";
const CONV_RUN = "conv_0000000000000003";
const CONV_OWNERLESS = "conv_0000000000000004";

interface SeedMeta {
  id: string;
  createdAt: string;
  ownerId?: string;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

/** Write one flat conversation file: line-1 metadata + a trivial body line. */
function seedFlat(workDir: string, meta: SeedMeta): string {
  const flatDir = join(workDir, "conversations");
  mkdirSync(flatDir, { recursive: true });
  const file = join(flatDir, `${meta.id}.jsonl`);
  const body = { ts: meta.createdAt, type: "user.message", content: [{ type: "text", text: "hi" }] };
  writeFileSync(file, `${JSON.stringify(meta)}\n${JSON.stringify(body)}\n`, "utf-8");
  return file;
}

describe("migrate-conversations-to-workspace", () => {
  let workDir: string;

  // The four seeded conversations and their expected destinations.
  let helixSrc: string;
  let personalSrc: string;
  let runSrc: string;
  let ownerlessSrc: string;

  let helixDest: string;
  let personalDest: string;
  let runDest: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-conv-workspace-migrate-"));

    // (a) explicit workspaceId + owner → that workspace's owner partition.
    helixSrc = seedFlat(workDir, {
      id: CONV_HELIX,
      createdAt: "2026-01-01T00:00:00.000Z",
      ownerId: OWNER,
      workspaceId: "ws_helix",
    });
    helixDest = join(workspaceConversationsDir(workDir, "ws_helix", OWNER), `${CONV_HELIX}.jsonl`);

    // (b) no workspaceId → owner's personal workspace.
    personalSrc = seedFlat(workDir, {
      id: CONV_PERSONAL,
      createdAt: "2026-01-02T00:00:00.000Z",
      ownerId: OTHER_OWNER,
    });
    personalDest = join(
      workspaceConversationsDir(workDir, personalWorkspaceIdFor(OTHER_OWNER), OTHER_OWNER),
      `${CONV_PERSONAL}.jsonl`,
    );

    // (c) automation run → that workspace's `_runs/<automationId>/` partition.
    runSrc = seedFlat(workDir, {
      id: CONV_RUN,
      createdAt: "2026-01-03T00:00:00.000Z",
      ownerId: OWNER,
      workspaceId: "ws_helix",
      metadata: { source: "task", automationId: "auto_x" },
    });
    runDest = join(runConversationsDir(workDir, "ws_helix", "auto_x"), `${CONV_RUN}.jsonl`);

    // (d) no ownerId → pre-migration; must be skipped and left in place.
    ownerlessSrc = seedFlat(workDir, {
      id: CONV_OWNERLESS,
      createdAt: "2026-01-04T00:00:00.000Z",
    });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test("dry-run plans every move but writes nothing", () => {
    const summary = migrateConversationsToWorkspace(workDir, { write: false });

    expect(summary.moved).toBe(3);
    expect(summary.skippedOwnerless).toBe(1);
    expect(summary.skippedExisting).toBe(0);

    // Nothing on disk changed: sources untouched, destinations absent.
    expect(existsSync(helixSrc)).toBe(true);
    expect(existsSync(personalSrc)).toBe(true);
    expect(existsSync(runSrc)).toBe(true);
    expect(existsSync(helixDest)).toBe(false);
    expect(existsSync(personalDest)).toBe(false);
    expect(existsSync(runDest)).toBe(false);
    // No lock left behind by a read-only run.
    expect(existsSync(join(workDir, ".migration-lock"))).toBe(false);
  });

  test("--write moves each conversation to its exact workspace-owned path", () => {
    const before = readFileSync(helixSrc, "utf-8");

    const summary = migrateConversationsToWorkspace(workDir, { write: true });

    expect(summary.moved).toBe(3);
    expect(summary.skippedOwnerless).toBe(1);

    // Destinations now exist at the precise paths the helpers compute.
    expect(existsSync(helixDest)).toBe(true);
    expect(existsSync(personalDest)).toBe(true);
    expect(existsSync(runDest)).toBe(true);

    // Flat sources for migrated files are gone.
    expect(existsSync(helixSrc)).toBe(false);
    expect(existsSync(personalSrc)).toBe(false);
    expect(existsSync(runSrc)).toBe(false);

    // The ownerless file is left exactly where it was.
    expect(existsSync(ownerlessSrc)).toBe(true);

    // Content is moved verbatim, and no temp/lock residue remains.
    expect(readFileSync(helixDest, "utf-8")).toBe(before);
    expect(existsSync(join(workDir, ".migration-lock"))).toBe(false);
    expect(existsSync(`${helixDest}.${process.pid}.tmp`)).toBe(false);
  });

  test("a second --write run is idempotent (0 moves)", () => {
    migrateConversationsToWorkspace(workDir, { write: true });
    const second = migrateConversationsToWorkspace(workDir, { write: true });

    expect(second.moved).toBe(0);
    expect(second.skippedExisting).toBe(0);
    // The lone remaining flat file is the ownerless one, still skipped.
    expect(second.skippedOwnerless).toBe(1);
    expect(existsSync(ownerlessSrc)).toBe(true);
  });

  test("crash recovery: a pre-existing destination removes the stale flat source", () => {
    // Simulate a prior partial run: the dest already exists, the flat source
    // was never unlinked.
    mkdirSync(workspaceConversationsDir(workDir, "ws_helix", OWNER), { recursive: true });
    writeFileSync(helixDest, readFileSync(helixSrc, "utf-8"), "utf-8");
    expect(existsSync(helixSrc)).toBe(true);

    const summary = migrateConversationsToWorkspace(workDir, { write: true });

    // helix counted as already-migrated; its stale flat source is removed.
    expect(summary.skippedExisting).toBe(1);
    expect(existsSync(helixSrc)).toBe(false);
    expect(existsSync(helixDest)).toBe(true);

    // The other two still move normally.
    expect(summary.moved).toBe(2);
    expect(existsSync(personalDest)).toBe(true);
    expect(existsSync(runDest)).toBe(true);
  });
});
