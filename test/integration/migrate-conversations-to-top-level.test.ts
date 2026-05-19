/**
 * Exercises scripts/migrate-conversations-to-top-level.ts against a fake
 * work tree. Classified as integration because it spawns `bun` on the
 * script.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const SCRIPT = join(
  import.meta.dirname ?? __dirname,
  "..",
  "..",
  "scripts",
  "migrate-conversations-to-top-level.ts",
);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-migrate-conv-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A canned ConversationEvent shape — the migration only inspects the
 * `type` field for filtering, so the rest is opaque pass-through.
 */
type Event = { ts: string; type: string; [k: string]: unknown };

interface SeedOpts {
  wsId: string;
  convId: string;
  ownerId?: string | null; // null = omit the field entirely (skip case)
  workspaceId?: string;
  visibility?: string; // legacy metadata field — should be stripped
  participants?: string[]; // legacy metadata field — should be stripped
  events?: Event[];
}

async function seedConversation(opts: SeedOpts): Promise<string> {
  const dir = join(workDir, "workspaces", opts.wsId, "conversations");
  await mkdir(dir, { recursive: true });
  const meta: Record<string, unknown> = {
    id: opts.convId,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    title: null,
    lastModel: null,
    format: "events",
  };
  if (opts.ownerId !== null) {
    meta.ownerId = opts.ownerId ?? "usr_alice";
  }
  if (opts.workspaceId) meta.workspaceId = opts.workspaceId;
  if (opts.visibility !== undefined) meta.visibility = opts.visibility;
  if (opts.participants !== undefined) meta.participants = opts.participants;

  const eventLines = (opts.events ?? [
    {
      ts: "2025-01-01T00:00:01.000Z",
      type: "user.message",
      content: [{ type: "text", text: "hi" }],
    },
  ])
    .map((e) => JSON.stringify(e))
    .join("\n");

  const path = join(dir, `${opts.convId}.jsonl`);
  await writeFile(path, `${JSON.stringify(meta)}\n${eventLines}\n`, { mode: 0o600 });
  return path;
}

async function runMigrate(args: string[] = []): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", SCRIPT, "--work-dir", workDir, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr };
}

async function readJsonl(path: string): Promise<{ meta: Record<string, unknown>; events: Record<string, unknown>[] }> {
  const raw = await readFile(path, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const [metaLine, ...eventLines] = lines;
  return {
    meta: JSON.parse(metaLine ?? "{}") as Record<string, unknown>,
    events: eventLines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

function topLevelPath(convId: string): string {
  return join(workDir, "conversations", `${convId}.jsonl`);
}

function workspacePath(wsId: string, convId: string): string {
  return join(workDir, "workspaces", wsId, "conversations", `${convId}.jsonl`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrate-conversations-to-top-level", () => {
  test("moves every conversation across multiple workspaces to top-level", async () => {
    // Two workspaces × three conversations each. Random-ish 16-hex ids so
    // collision detection has nothing to flag.
    const ws1 = "ws_user_user_alice";
    const ws2 = "ws_user_user_bob";
    const aliceIds = [
      "conv_aaaaaaaaaaaa1111",
      "conv_aaaaaaaaaaaa2222",
      "conv_aaaaaaaaaaaa3333",
    ];
    const bobIds = [
      "conv_bbbbbbbbbbbb1111",
      "conv_bbbbbbbbbbbb2222",
      "conv_bbbbbbbbbbbb3333",
    ];
    for (const id of aliceIds) {
      await seedConversation({ wsId: ws1, convId: id, ownerId: "usr_alice" });
    }
    for (const id of bobIds) {
      await seedConversation({ wsId: ws2, convId: id, ownerId: "usr_bob" });
    }

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("conversations found:     6");
    expect(stderr).toContain("moved:                   6");

    for (const id of aliceIds) {
      expect(existsSync(topLevelPath(id))).toBe(true);
      expect(existsSync(workspacePath(ws1, id))).toBe(false);
      const { meta } = await readJsonl(topLevelPath(id));
      expect(meta.ownerId).toBe("usr_alice");
      expect(meta.id).toBe(id);
      expect(meta.visibility).toBeUndefined();
      expect(meta.participants).toBeUndefined();
    }
    for (const id of bobIds) {
      expect(existsSync(topLevelPath(id))).toBe(true);
      expect(existsSync(workspacePath(ws2, id))).toBe(false);
      const { meta } = await readJsonl(topLevelPath(id));
      expect(meta.ownerId).toBe("usr_bob");
    }
  });

  test("is idempotent — a second run reports zero moves", async () => {
    await seedConversation({
      wsId: "ws_user_user_alice",
      convId: "conv_cccccccccccc1234",
      ownerId: "usr_alice",
    });

    const first = await runMigrate();
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain("moved:                   1");

    const second = await runMigrate();
    expect(second.exitCode).toBe(0);
    // Second run sees zero candidates because the first run's source-
    // delete completed the move; the script short-circuits with the
    // "nothing to do" line and never prints the full summary.
    expect(second.stderr).toContain("found 0 conversation file(s)");
    expect(second.stderr).toContain("nothing to do");
  });

  test("--dry-run reports the plan without writing", async () => {
    await seedConversation({
      wsId: "ws_user_user_alice",
      convId: "conv_dddddddddddd5678",
      ownerId: "usr_alice",
    });

    const { exitCode, stderr } = await runMigrate(["--dry-run"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("(dry-run)");
    expect(stderr).toContain("would move");

    // Source still present, destination NOT present.
    expect(existsSync(workspacePath("ws_user_user_alice", "conv_dddddddddddd5678"))).toBe(true);
    expect(existsSync(topLevelPath("conv_dddddddddddd5678"))).toBe(false);
  });

  test("skips conversations missing ownerId; counts them; leaves the source untouched", async () => {
    await seedConversation({
      wsId: "ws_user_user_alice",
      convId: "conv_eeeeeeeeeeee0001",
      ownerId: null,
    });
    await seedConversation({
      wsId: "ws_user_user_alice",
      convId: "conv_eeeeeeeeeeee0002",
      ownerId: "usr_alice",
    });

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("skipped (no ownerId):    1");
    expect(stderr).toContain("moved:                   1");
    expect(stderr).toMatch(/SKIP .*conv_eeeeeeeeeeee0001/);

    // Owner-less source preserved as-is for operator triage.
    expect(existsSync(workspacePath("ws_user_user_alice", "conv_eeeeeeeeeeee0001"))).toBe(true);
    expect(existsSync(topLevelPath("conv_eeeeeeeeeeee0001"))).toBe(false);

    // The owned conversation moved normally.
    expect(existsSync(topLevelPath("conv_eeeeeeeeeeee0002"))).toBe(true);
  });

  test("drops removed event types and strips removed metadata fields; passes other lines through byte-identical", async () => {
    const convId = "conv_ffffffffffff9999";
    const events: Event[] = [
      { ts: "2025-01-01T00:00:01.000Z", type: "user.message", content: [{ type: "text", text: "hi" }] },
      { ts: "2025-01-01T00:00:02.000Z", type: "metadata.visibility", visibility: "shared" },
      { ts: "2025-01-01T00:00:03.000Z", type: "run.start", runId: "run_xyz", model: "echo" },
      { ts: "2025-01-01T00:00:04.000Z", type: "metadata.participants", participants: ["usr_alice", "usr_bob"] },
      { ts: "2025-01-01T00:00:05.000Z", type: "run.done", runId: "run_xyz" },
      // Decoy: a user message that *contains* the word "visibility" must not be dropped.
      { ts: "2025-01-01T00:00:06.000Z", type: "user.message", content: [{ type: "text", text: "talk about visibility participants" }] },
    ];

    // Capture the byte-exact lines that should be preserved so we can
    // assert byte-identity on the destination file later.
    const preservedLineBytes = events
      .filter((e) => e.type !== "metadata.visibility" && e.type !== "metadata.participants")
      .map((e) => JSON.stringify(e));

    await seedConversation({
      wsId: "ws_user_user_alice",
      convId,
      ownerId: "usr_alice",
      visibility: "shared", // legacy metadata field — must be stripped
      participants: ["usr_alice"], // legacy metadata field — must be stripped
      events,
    });

    const { exitCode } = await runMigrate();
    expect(exitCode).toBe(0);

    const destRaw = await readFile(topLevelPath(convId), "utf-8");
    const destLines = destRaw.split("\n").filter((l) => l.length > 0);

    // Metadata line: visibility/participants stripped, ownerId intact.
    const meta = JSON.parse(destLines[0]!) as Record<string, unknown>;
    expect(meta.ownerId).toBe("usr_alice");
    expect(meta.visibility).toBeUndefined();
    expect(meta.participants).toBeUndefined();

    // Event lines: exactly the non-filtered originals, byte-identical
    // (no key reordering, no whitespace drift).
    const destEventLines = destLines.slice(1);
    expect(destEventLines).toEqual(preservedLineBytes);

    // The decoy user message — content mentions both removed type names —
    // survives intact. Confirms the filter is on `.type` exact-match,
    // not substring on the raw line.
    const decoy = destEventLines[destEventLines.length - 1] ?? "";
    expect(decoy).toContain("talk about visibility participants");
  });

  test("[FATAL] exits non-zero when the same convId appears in two workspaces", async () => {
    const collidingId = "conv_aabbccddeeff0011";
    await seedConversation({
      wsId: "ws_user_user_alice",
      convId: collidingId,
      ownerId: "usr_alice",
    });
    await seedConversation({
      wsId: "ws_user_user_bob",
      convId: collidingId,
      ownerId: "usr_bob",
    });

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(2);
    expect(stderr).toContain("[FATAL]");
    expect(stderr).toContain(`convId=${collidingId}`);
    expect(stderr).toContain("ws_user_user_alice");
    expect(stderr).toContain("ws_user_user_bob");

    // Nothing was moved.
    expect(existsSync(topLevelPath(collidingId))).toBe(false);
    expect(existsSync(workspacePath("ws_user_user_alice", collidingId))).toBe(true);
    expect(existsSync(workspacePath("ws_user_user_bob", collidingId))).toBe(true);
  });

  test("recovers from a crashed prior run: source AND destination both present → source is re-deleted", async () => {
    // Simulate the partial state. The destination file is structurally
    // valid post-write (the rename is the commit point), so the recovery
    // path trusts it and just clears the stale source.
    const convId = "conv_baadc0ffeedead00";
    const ws = "ws_user_user_alice";
    await seedConversation({ wsId: ws, convId, ownerId: "usr_alice" });

    // Hand-create the destination as if a prior run had succeeded at
    // the rename step but died before the source-delete. The bytes don't
    // need to match — the contract is "trust whatever is at the
    // destination, the rename was the commit."
    const destDir = join(workDir, "conversations");
    await mkdir(destDir, { recursive: true });
    await writeFile(
      topLevelPath(convId),
      `${JSON.stringify({ id: convId, ownerId: "usr_alice", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", title: null, lastModel: null, format: "events" })}\n`,
      { mode: 0o600 },
    );

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("recovered (post-crash):  1");
    expect(stderr).toContain("moved:                   0");

    // Source gone, destination preserved.
    expect(existsSync(workspacePath(ws, convId))).toBe(false);
    expect(existsSync(topLevelPath(convId))).toBe(true);
  });

  test("preserves file mode 0o600 on the migrated destination", async () => {
    await seedConversation({
      wsId: "ws_user_user_alice",
      convId: "conv_facefacefaceface",
      ownerId: "usr_alice",
    });
    const { exitCode } = await runMigrate();
    expect(exitCode).toBe(0);

    const s = await stat(topLevelPath("conv_facefacefaceface"));
    // Compare the low 9 mode bits (rwx for u/g/o) against 0o600.
    expect(s.mode & 0o777).toBe(0o600);
  });

  test("leaves the empty workspaces/<wsId>/conversations/ directory in place after the move", async () => {
    await seedConversation({
      wsId: "ws_user_user_alice",
      convId: "conv_cafef00dcafe1111",
      ownerId: "usr_alice",
    });
    const { exitCode } = await runMigrate();
    expect(exitCode).toBe(0);

    // The convDir still exists but is empty.
    const convDir = join(workDir, "workspaces", "ws_user_user_alice", "conversations");
    expect(existsSync(convDir)).toBe(true);
    const remaining = await readdir(convDir);
    expect(remaining).toEqual([]);
  });
});
