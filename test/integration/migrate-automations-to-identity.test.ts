/**
 * Exercises scripts/migrate-automations-to-identity.ts against a fake work
 * tree. Classified as integration because it spawns `bun` on the script.
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
  "migrate-automations-to-identity.ts",
);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-migrate-auto-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Member {
  userId: string;
  role: "admin" | "member";
}

async function seedWorkspace(opts: {
  wsId: string;
  isPersonal?: boolean;
  ownerUserId?: string;
  members?: Member[];
}): Promise<void> {
  const dir = join(workDir, "workspaces", opts.wsId);
  await mkdir(dir, { recursive: true });
  const meta: Record<string, unknown> = {
    id: opts.wsId,
    name: opts.wsId,
    members: opts.members ?? [],
    bundles: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
  if (opts.isPersonal) {
    meta.isPersonal = true;
    meta.ownerUserId = opts.ownerUserId;
    meta.members = [{ userId: opts.ownerUserId, role: "admin" }];
  }
  await writeFile(join(dir, "workspace.json"), JSON.stringify(meta));
}

/** Append an automation to a source store (workspace-scoped or instance-level). */
async function seedAutomation(opts: {
  wsId?: string; // omit for the instance-level store
  id: string;
  ownerId?: string;
  withRun?: boolean;
}): Promise<void> {
  const baseDir = opts.wsId
    ? join(workDir, "workspaces", opts.wsId, "automations")
    : join(workDir, "automations");
  await mkdir(baseDir, { recursive: true });
  const filePath = join(baseDir, "automations.json");
  let automations: Record<string, unknown>[] = [];
  if (existsSync(filePath)) {
    automations = (JSON.parse(await readFile(filePath, "utf-8")) as { automations: Record<string, unknown>[] })
      .automations;
  }
  automations.push({
    id: opts.id,
    name: opts.id,
    prompt: `run ${opts.id}`,
    schedule: { type: "interval", intervalMs: 3_600_000 },
    enabled: false,
    source: "user",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
  });
  await writeFile(
    filePath,
    `${JSON.stringify({ version: 1, updatedAtMs: Date.now(), automations }, null, 2)}\n`,
  );
  if (opts.withRun) {
    const runsDir = join(baseDir, "runs");
    await mkdir(runsDir, { recursive: true });
    await writeFile(join(runsDir, `${opts.id}.jsonl`), `${JSON.stringify({ id: "run_1" })}\n`);
  }
}

async function runMigrate(args: string[] = []): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", SCRIPT, "--work-dir", workDir, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stderr };
}

async function destAutomations(userId: string): Promise<Record<string, unknown>[]> {
  const path = join(workDir, "users", userId, "automations", "automations.json");
  if (!existsSync(path)) return [];
  return (JSON.parse(await readFile(path, "utf-8")) as { automations: Record<string, unknown>[] }).automations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrate-automations-to-identity", () => {
  test("personal workspace: stamps owner + provenance, removes source dir", async () => {
    await seedWorkspace({ wsId: "ws_user_usr_alice", isPersonal: true, ownerUserId: "usr_alice" });
    await seedAutomation({ wsId: "ws_user_usr_alice", id: "daily-digest", withRun: true });

    const { exitCode } = await runMigrate();
    expect(exitCode).toBe(0);

    const dest = await destAutomations("usr_alice");
    expect(dest).toHaveLength(1);
    expect(dest[0]?.id).toBe("daily-digest");
    expect(dest[0]?.ownerId).toBe("usr_alice");
    expect(dest[0]?.workspaceId).toBe("ws_user_usr_alice");
    // Run history moved.
    expect(
      existsSync(join(workDir, "users", "usr_alice", "automations", "runs", "daily-digest.jsonl")),
    ).toBe(true);
    // Clean move: emptied source automations dir removed.
    expect(existsSync(join(workDir, "workspaces", "ws_user_usr_alice", "automations"))).toBe(false);
  });

  test("team workspace: owner resolves to the earliest admin", async () => {
    await seedWorkspace({
      wsId: "ws_team0000000001",
      members: [
        { userId: "usr_carol", role: "member" },
        { userId: "usr_dave", role: "admin" },
      ],
    });
    await seedAutomation({ wsId: "ws_team0000000001", id: "weekly-report" });

    const { exitCode } = await runMigrate();
    expect(exitCode).toBe(0);
    const dest = await destAutomations("usr_dave");
    expect(dest[0]?.ownerId).toBe("usr_dave");
    expect(dest[0]?.workspaceId).toBe("ws_team0000000001");
  });

  test("instance-level automation with ownerId migrates to that owner", async () => {
    await seedAutomation({ id: "legacy-job", ownerId: "usr_erin" });

    const { exitCode } = await runMigrate();
    expect(exitCode).toBe(0);
    const dest = await destAutomations("usr_erin");
    expect(dest).toHaveLength(1);
    expect(dest[0]?.ownerId).toBe("usr_erin");
    // Instance-level source has no workspace → no provenance stamped.
    expect(dest[0]?.workspaceId).toBeUndefined();
  });

  test("idempotent: a second run migrates nothing", async () => {
    await seedWorkspace({ wsId: "ws_user_usr_alice", isPersonal: true, ownerUserId: "usr_alice" });
    await seedAutomation({ wsId: "ws_user_usr_alice", id: "daily-digest" });

    const first = await runMigrate();
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain("migrated:            1");

    const second = await runMigrate();
    expect(second.exitCode).toBe(0);
    expect(second.stderr).toContain("migrated:            0");
    expect(await destAutomations("usr_alice")).toHaveLength(1);
  });

  test("dry-run writes nothing", async () => {
    await seedWorkspace({ wsId: "ws_user_usr_alice", isPersonal: true, ownerUserId: "usr_alice" });
    await seedAutomation({ wsId: "ws_user_usr_alice", id: "daily-digest" });

    const { exitCode, stderr } = await runMigrate(["--dry-run"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("would move");
    expect(existsSync(join(workDir, "users", "usr_alice"))).toBe(false);
    expect(existsSync(join(workDir, "workspaces", "ws_user_usr_alice", "automations"))).toBe(true);
  });

  test("FATAL: team workspace with no admin", async () => {
    await seedWorkspace({ wsId: "ws_team0000000002", members: [{ userId: "usr_f", role: "member" }] });
    await seedAutomation({ wsId: "ws_team0000000002", id: "orphan-job" });

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(2);
    expect(stderr).toContain("[FATAL]");
    expect(stderr).toContain("no resolvable owner");
    expect(existsSync(join(workDir, "users"))).toBe(false);
  });

  test("FATAL: instance-level automation with no ownerId", async () => {
    await seedAutomation({ id: "ownerless" });

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(2);
    expect(stderr).toContain("[FATAL]");
    expect(stderr).toContain("no resolvable owner");
  });

  test("FATAL: same (owner, id) in two workspaces", async () => {
    await seedWorkspace({ wsId: "ws_a00000000001", members: [{ userId: "usr_g", role: "admin" }] });
    await seedWorkspace({ wsId: "ws_b00000000002", members: [{ userId: "usr_g", role: "admin" }] });
    await seedAutomation({ wsId: "ws_a00000000001", id: "dupe-job" });
    await seedAutomation({ wsId: "ws_b00000000002", id: "dupe-job" });

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(2);
    expect(stderr).toContain("[FATAL]");
    expect(stderr).toContain("multiple sources");
    expect(existsSync(join(workDir, "users"))).toBe(false);
  });
});
