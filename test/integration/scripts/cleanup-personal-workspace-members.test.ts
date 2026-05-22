/**
 * Exercises scripts/cleanup-personal-workspace-members.ts against a fake
 * work tree. Classified as integration because it spawns `bun` on the
 * script.
 *
 * Covers:
 *   - Multi-admin personal workspace gets cleaned to sole-owner-admin.
 *   - Workspace already in desired state is a no-op (idempotency).
 *   - Missing `ownerUserId` on a personal workspace → hard-error.
 *   - Non-personal workspace is untouched.
 *   - Dry-run is the default; --apply is required to write.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const SCRIPT = join(
  import.meta.dirname ?? __dirname,
  "..",
  "..",
  "..",
  "scripts",
  "cleanup-personal-workspace-members.ts",
);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-cleanup-pwm-"));
  // Cleanup script walks `workspaces/*/workspace.json`; the dir must exist.
  await mkdir(join(workDir, "workspaces"), { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

interface SeedOpts {
  id: string;
  name?: string;
  members: Array<{ userId: string; role: "admin" | "member" }>;
  isPersonal?: boolean;
  ownerUserId?: string;
}

async function seedWorkspace(opts: SeedOpts): Promise<void> {
  const wsDir = join(workDir, "workspaces", opts.id);
  await mkdir(wsDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const ws: Record<string, unknown> = {
    id: opts.id,
    name: opts.name ?? opts.id,
    members: opts.members,
    bundles: [],
    createdAt: now,
    updatedAt: now,
  };
  if (opts.isPersonal !== undefined) ws.isPersonal = opts.isPersonal;
  if (opts.ownerUserId !== undefined) ws.ownerUserId = opts.ownerUserId;
  await writeFile(join(wsDir, "workspace.json"), `${JSON.stringify(ws, null, 2)}\n`);
}

async function readWorkspace(id: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(workDir, "workspaces", id, "workspace.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function runCleanup(args: string[] = []): Promise<{ exitCode: number; stderr: string }> {
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

describe("cleanup-personal-workspace-members", () => {
  test("multi-admin personal workspace gets cleaned to sole-owner-admin", async () => {
    // The exact failure mode that motivated the script: a personal
    // workspace with three admins.
    await seedWorkspace({
      id: "ws_user_user_alice",
      isPersonal: true,
      ownerUserId: "user_alice",
      members: [
        { userId: "user_alice", role: "admin" },
        { userId: "user_b", role: "admin" },
        { userId: "user_c", role: "admin" },
      ],
    });

    const { exitCode, stderr } = await runCleanup(["--apply"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("ws_user_user_alice");
    // The log should name the dropped members so the operator can
    // verify what was removed.
    expect(stderr).toContain("user_b");
    expect(stderr).toContain("user_c");

    const ws = await readWorkspace("ws_user_user_alice");
    expect(ws.members).toEqual([{ userId: "user_alice", role: "admin" }]);
    expect(ws.isPersonal).toBe(true);
    expect(ws.ownerUserId).toBe("user_alice");
  });

  test("personal workspace with the owner-only-member but non-admin role gets fixed to admin", async () => {
    await seedWorkspace({
      id: "ws_user_user_bob",
      isPersonal: true,
      ownerUserId: "user_bob",
      members: [{ userId: "user_bob", role: "member" }],
    });

    const { exitCode } = await runCleanup(["--apply"]);
    expect(exitCode).toBe(0);

    const ws = await readWorkspace("ws_user_user_bob");
    expect(ws.members).toEqual([{ userId: "user_bob", role: "admin" }]);
  });

  test("workspace already in canonical shape is a no-op (idempotency)", async () => {
    await seedWorkspace({
      id: "ws_user_user_alice",
      isPersonal: true,
      ownerUserId: "user_alice",
      members: [{ userId: "user_alice", role: "admin" }],
    });

    const before = await readWorkspace("ws_user_user_alice");

    const { exitCode, stderr } = await runCleanup(["--apply"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("already canonical:       1");

    const after = await readWorkspace("ws_user_user_alice");
    // Idempotent: even `updatedAt` is untouched because we don't write.
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  test("missing ownerUserId on a personal workspace is a hard-error", async () => {
    await seedWorkspace({
      id: "ws_user_orphan",
      isPersonal: true,
      // ownerUserId intentionally omitted — simulates pre-Stage-1
      // tenants where the migration's stamp didn't reach this row.
      members: [{ userId: "user_x", role: "admin" }],
    });

    const { exitCode, stderr } = await runCleanup(["--apply"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no ownerUserId");

    // The bad-state workspace is left alone so the operator can triage.
    const ws = await readWorkspace("ws_user_orphan");
    expect(ws.members).toEqual([{ userId: "user_x", role: "admin" }]);
  });

  test("non-personal workspace is untouched even when it has many admins", async () => {
    await seedWorkspace({
      id: "ws_team_alpha",
      isPersonal: false,
      members: [
        { userId: "user_a", role: "admin" },
        { userId: "user_b", role: "admin" },
        { userId: "user_c", role: "member" },
      ],
    });

    const { exitCode, stderr } = await runCleanup(["--apply"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("non-personal skipped:    1");

    const ws = await readWorkspace("ws_team_alpha");
    expect(ws.members).toEqual([
      { userId: "user_a", role: "admin" },
      { userId: "user_b", role: "admin" },
      { userId: "user_c", role: "member" },
    ]);
  });

  test("dry-run is the default — without --apply, no writes happen", async () => {
    await seedWorkspace({
      id: "ws_user_user_alice",
      isPersonal: true,
      ownerUserId: "user_alice",
      members: [
        { userId: "user_alice", role: "admin" },
        { userId: "user_evil", role: "admin" },
      ],
    });

    const before = await readWorkspace("ws_user_user_alice");

    const { exitCode, stderr } = await runCleanup();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("would clean");

    // Disk state unchanged.
    const after = await readWorkspace("ws_user_user_alice");
    expect(after).toEqual(before);
  });
});
