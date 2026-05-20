/**
 * Exercises scripts/migrate-personal-workspaces.ts against a fake work tree.
 * Classified as integration because it spawns `bun` on the script.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const SCRIPT = join(
  import.meta.dirname ?? __dirname,
  "..",
  "..",
  "scripts",
  "migrate-personal-workspaces.ts",
);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-migrate-pw-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function seedUser(id: string, email: string, displayName: string): Promise<void> {
  const dir = join(workDir, "users", id);
  await mkdir(dir, { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    join(dir, "profile.json"),
    `${JSON.stringify(
      {
        id,
        email,
        displayName,
        orgRole: "member",
        preferences: {},
        createdAt: now,
        updatedAt: now,
      },
      null,
      2,
    )}\n`,
  );
}

async function seedWorkspace(opts: {
  id: string;
  name: string;
  members: Array<{ userId: string; role: "admin" | "member" }>;
  isPersonal?: boolean;
  ownerUserId?: string;
  about?: string | null;
}): Promise<void> {
  const wsDir = join(workDir, "workspaces", opts.id);
  await mkdir(wsDir, { recursive: true, mode: 0o700 });
  await mkdir(join(wsDir, "conversations"), { recursive: true });
  const now = new Date().toISOString();
  const ws: Record<string, unknown> = {
    id: opts.id,
    name: opts.name,
    members: opts.members,
    bundles: [],
    createdAt: now,
    updatedAt: now,
  };
  // Only include the new fields when the caller specifies them — many
  // tests seed legacy-shape workspaces that lack these fields.
  if (opts.isPersonal !== undefined) ws.isPersonal = opts.isPersonal;
  if (opts.ownerUserId !== undefined) ws.ownerUserId = opts.ownerUserId;
  if (opts.about !== undefined) ws.about = opts.about;
  await writeFile(join(wsDir, "workspace.json"), `${JSON.stringify(ws, null, 2)}\n`);
}

async function seedConversation(opts: {
  wsId: string;
  convId: string;
  workspaceId: string | null;
}): Promise<void> {
  const dir = join(workDir, "workspaces", opts.wsId, "conversations");
  await mkdir(dir, { recursive: true });
  const metadata = {
    id: opts.convId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: null,
    lastModel: null,
    ownerId: "user_alice",
    ...(opts.workspaceId !== null ? { workspaceId: opts.workspaceId } : {}),
    format: "events",
  };
  // First line metadata; second line a fake user event so we can verify
  // pass-through preservation.
  const body =
    `${JSON.stringify(metadata)}\n` +
    `${JSON.stringify({ ts: new Date().toISOString(), type: "user.message", content: [{ type: "text", text: "hi" }] })}\n`;
  await writeFile(join(dir, `${opts.convId}.jsonl`), body);
}

async function readWorkspace(id: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(workDir, "workspaces", id, "workspace.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readConvMetadata(wsId: string, convId: string): Promise<Record<string, unknown>> {
  const raw = await readFile(
    join(workDir, "workspaces", wsId, "conversations", `${convId}.jsonl`),
    "utf-8",
  );
  const firstLine = raw.split("\n")[0] ?? "";
  return JSON.parse(firstLine) as Record<string, unknown>;
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

describe("migrate-personal-workspaces", () => {
  test("renames a legacy personal workspace + stamps identity fields", async () => {
    await seedUser("user_alice", "alice@example.com", "Alice");
    await seedWorkspace({
      id: "ws_alice",
      name: "Alice's Workspace",
      members: [{ userId: "user_alice", role: "admin" }],
    });

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("renaming ws_alice → ws_user_user_alice");

    // Old dir gone, new dir present.
    expect(existsSync(join(workDir, "workspaces", "ws_alice"))).toBe(false);
    expect(existsSync(join(workDir, "workspaces", "ws_user_user_alice"))).toBe(true);

    // Identity fields stamped.
    const ws = await readWorkspace("ws_user_user_alice");
    expect(ws.id).toBe("ws_user_user_alice");
    expect(ws.isPersonal).toBe(true);
    expect(ws.ownerUserId).toBe("user_alice");
    expect(ws.about).toBeNull();
    expect(ws.members).toEqual([{ userId: "user_alice", role: "admin" }]);
  });

  test("rewrites workspaceId in conversation metadata after rename", async () => {
    await seedUser("user_alice", "alice@example.com", "Alice");
    await seedWorkspace({
      id: "ws_alice",
      name: "Alice",
      members: [{ userId: "user_alice", role: "admin" }],
    });
    await seedConversation({ wsId: "ws_alice", convId: "conv_one", workspaceId: "ws_alice" });

    const { exitCode } = await runMigrate();
    expect(exitCode).toBe(0);

    const meta = await readConvMetadata("ws_user_user_alice", "conv_one");
    expect(meta.workspaceId).toBe("ws_user_user_alice");

    // Subsequent event lines passed through byte-identical.
    const raw = await readFile(
      join(workDir, "workspaces", "ws_user_user_alice", "conversations", "conv_one.jsonl"),
      "utf-8",
    );
    expect(raw).toContain('"type":"user.message"');
    expect(raw).toContain('"text":"hi"');
  });

  test("stamps identity fields when workspace is already at the new canonical id", async () => {
    await seedUser("user_alice", "alice@example.com", "Alice");
    await seedWorkspace({
      id: "ws_user_user_alice",
      name: "Alice's Workspace",
      members: [{ userId: "user_alice", role: "admin" }],
      // No isPersonal / ownerUserId — simulate a workspace created by
      // ensureUserWorkspace before Task 001 rolled out (or hand-created).
    });

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("stamped identity fields");

    const ws = await readWorkspace("ws_user_user_alice");
    expect(ws.isPersonal).toBe(true);
    expect(ws.ownerUserId).toBe("user_alice");
  });

  test("is a no-op on a fully-migrated workspace (idempotent second run)", async () => {
    await seedUser("user_alice", "alice@example.com", "Alice");
    await seedWorkspace({
      id: "ws_user_user_alice",
      name: "Alice's Workspace",
      members: [{ userId: "user_alice", role: "admin" }],
      isPersonal: true,
      ownerUserId: "user_alice",
      about: null,
    });

    const before = await readWorkspace("ws_user_user_alice");

    const { exitCode } = await runMigrate();
    expect(exitCode).toBe(0);

    const after = await readWorkspace("ws_user_user_alice");
    // Identity fields unchanged; updatedAt may or may not be touched
    // (the script's idempotency criterion is "no observable changes
    // beyond a refreshed timestamp" — we assert the load-bearing fields).
    expect(after.isPersonal).toBe(true);
    expect(after.ownerUserId).toBe("user_alice");
    expect(after.id).toBe(before.id);
    expect(after.members).toEqual(before.members);
  });

  test("dry-run reports the plan but writes nothing", async () => {
    await seedUser("user_alice", "alice@example.com", "Alice");
    await seedWorkspace({
      id: "ws_alice",
      name: "Alice",
      members: [{ userId: "user_alice", role: "admin" }],
    });

    const { exitCode, stderr } = await runMigrate(["--dry-run"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("[dry-run] would rename ws_alice → ws_user_user_alice");

    // Source untouched.
    expect(existsSync(join(workDir, "workspaces", "ws_alice"))).toBe(true);
    expect(existsSync(join(workDir, "workspaces", "ws_user_user_alice"))).toBe(false);
  });

  test("stamps isPersonal: false on non-personal workspaces", async () => {
    await seedUser("user_alice", "alice@example.com", "Alice");
    // Personal workspace (already at new id).
    await seedWorkspace({
      id: "ws_user_user_alice",
      name: "Alice",
      members: [{ userId: "user_alice", role: "admin" }],
      isPersonal: true,
      ownerUserId: "user_alice",
    });
    // A shared workspace with no isPersonal field on disk.
    await seedWorkspace({
      id: "ws_shared_team",
      name: "Team",
      members: [{ userId: "user_alice", role: "member" }],
    });

    const { exitCode } = await runMigrate();
    expect(exitCode).toBe(0);

    const shared = await readWorkspace("ws_shared_team");
    expect(shared.isPersonal).toBe(false);
    expect(shared.about).toBeNull();
    expect(shared.ownerUserId).toBeUndefined();
  });

  test("leaves workspaces alone when the user has no detectable personal workspace", async () => {
    await seedUser("user_alice", "alice@example.com", "Alice");
    // Only a shared membership — no personal workspace at either old or new id.
    await seedWorkspace({
      id: "ws_shared",
      name: "Shared",
      members: [{ userId: "user_alice", role: "member" }],
    });

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("no personal workspace found");

    // Shared workspace still there.
    expect(existsSync(join(workDir, "workspaces", "ws_shared"))).toBe(true);
    // No new personal workspace created — `ensureUserWorkspace` will do
    // that lazily on next login.
    expect(existsSync(join(workDir, "workspaces", "ws_user_user_alice"))).toBe(false);
  });

  test("logs an ORPHANED warning when both legacy and new ids exist", async () => {
    await seedUser("user_alice", "alice@example.com", "Alice");
    // Both legacy and new id exist — data corruption scenario.
    await seedWorkspace({
      id: "ws_alice",
      name: "Legacy",
      members: [{ userId: "user_alice", role: "admin" }],
    });
    await seedWorkspace({
      id: "ws_user_user_alice",
      name: "Already here",
      members: [{ userId: "user_alice", role: "admin" }],
      isPersonal: true,
      ownerUserId: "user_alice",
    });

    const { exitCode, stderr } = await runMigrate();
    // Exit is still 0 — the migration didn't fail, the new-id workspace
    // is canonical and the operator owns the cleanup decision.
    expect(exitCode).toBe(0);
    // But the orphan MUST surface in the log so operators don't miss it.
    expect(stderr).toContain("ORPHANED legacy workspace at ws_alice");
    expect(stderr).toContain("Operator action required");
    // No rename happened.
    expect(stderr).not.toContain("renaming ws_alice");
    // Both directories still exist; operator decides.
    expect(existsSync(join(workDir, "workspaces", "ws_alice"))).toBe(true);
    expect(existsSync(join(workDir, "workspaces", "ws_user_user_alice"))).toBe(true);
  });

  test("heals a partial-rename: dir at new id, workspace.json#id stuck on old id", async () => {
    // Simulate the crash window between `rename(2)` (directory moved
    // atomically to the new path) and the workspace.json rewrite
    // (still carries the old embedded `id`). The migration's
    // "personal at new id" branch must heal this on rerun.
    await seedUser("user_alice", "alice@example.com", "Alice");
    const newId = "ws_user_user_alice";
    const wsDir = join(workDir, "workspaces", newId);
    await mkdir(wsDir, { recursive: true, mode: 0o700 });
    await mkdir(join(wsDir, "conversations"), { recursive: true });
    const now = new Date().toISOString();
    // Note: file at newId path, but the EMBEDDED id is still the
    // legacy slug. No isPersonal / ownerUserId yet (the rewrite
    // would have set those).
    await writeFile(
      join(wsDir, "workspace.json"),
      `${JSON.stringify(
        {
          id: "ws_alice",
          name: "Alice's Workspace",
          members: [{ userId: "user_alice", role: "admin" }],
          bundles: [],
          createdAt: now,
          updatedAt: now,
        },
        null,
        2,
      )}\n`,
    );

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("stamped identity fields");

    const ws = await readWorkspace(newId);
    // Healed: id matches the directory it lives in.
    expect(ws.id).toBe(newId);
    expect(ws.isPersonal).toBe(true);
    expect(ws.ownerUserId).toBe("user_alice");
  });

  test("--help exits 0 and prints usage", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "run", SCRIPT, "--help"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("migrate-personal-workspaces");
    expect(stdout).toContain("--work-dir");
    expect(stdout).toContain("--dry-run");
  });
});
