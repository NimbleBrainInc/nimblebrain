/**
 * Exercises scripts/migrate-files-to-identity.ts against a fake work tree.
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
  "migrate-files-to-identity.ts",
);

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-migrate-files-"));
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

async function seedFile(opts: {
  wsId: string;
  id: string;
  filename: string;
  body?: string;
  sidecar?: boolean;
  deleted?: boolean;
}): Promise<void> {
  const filesDir = join(workDir, "workspaces", opts.wsId, "files");
  await mkdir(filesDir, { recursive: true });
  const body = opts.body ?? `bytes-of-${opts.id}`;
  await writeFile(join(filesDir, `${opts.id}_${opts.filename}`), body);
  if (opts.sidecar) {
    await writeFile(
      join(filesDir, `${opts.id}.extracted.json`),
      JSON.stringify({ text: `extract-${opts.id}`, maxSize: 1000, truncated: false }),
    );
  }
  const entry = {
    id: opts.id,
    filename: opts.filename,
    mimeType: "text/plain",
    size: body.length,
    tags: [],
    source: "chat",
    conversationId: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    description: null,
    ...(opts.deleted ? { deleted: true, deletedAt: "2025-01-02T00:00:00.000Z" } : {}),
  };
  await writeFile(join(filesDir, "registry.jsonl"), `${JSON.stringify(entry)}\n`, { flag: "a" });
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

function identityBlob(userId: string, id: string, filename: string): string {
  return join(workDir, "users", userId, "files", `${id}_${filename}`);
}

async function readDestRegistry(
  userId: string,
): Promise<Record<string, unknown>[]> {
  const path = join(workDir, "users", userId, "files", "registry.jsonl");
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf-8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrate-files-to-identity", () => {
  test("personal workspace: file moves to owner's identity store with provenance stamped", async () => {
    await seedWorkspace({ wsId: "ws_user_usr_alice", isPersonal: true, ownerUserId: "usr_alice" });
    await seedFile({
      wsId: "ws_user_usr_alice",
      id: "fl_aaaaaaaaaaaaaaaaaaaaaaaa",
      filename: "report.txt",
      sidecar: true,
    });

    const { exitCode } = await runMigrate();
    expect(exitCode).toBe(0);

    // Destination blob + sidecar present; source blob gone.
    expect(existsSync(identityBlob("usr_alice", "fl_aaaaaaaaaaaaaaaaaaaaaaaa", "report.txt"))).toBe(
      true,
    );
    expect(
      existsSync(join(workDir, "users", "usr_alice", "files", "fl_aaaaaaaaaaaaaaaaaaaaaaaa.extracted.json")),
    ).toBe(true);
    expect(
      existsSync(
        join(workDir, "workspaces", "ws_user_usr_alice", "files", "fl_aaaaaaaaaaaaaaaaaaaaaaaa_report.txt"),
      ),
    ).toBe(false);

    // Registry entry carries the provenance workspaceId.
    const reg = await readDestRegistry("usr_alice");
    expect(reg).toHaveLength(1);
    expect(reg[0]?.workspaceId).toBe("ws_user_usr_alice");
    expect(reg[0]?.id).toBe("fl_aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("team workspace: owner resolves to the earliest admin", async () => {
    await seedWorkspace({
      wsId: "ws_team0000000001",
      members: [
        { userId: "usr_carol", role: "member" },
        { userId: "usr_dave", role: "admin" },
        { userId: "usr_erin", role: "admin" },
      ],
    });
    await seedFile({ wsId: "ws_team0000000001", id: "fl_bbbbbbbbbbbbbbbbbbbbbbbb", filename: "deck.pdf" });

    const { exitCode } = await runMigrate();
    expect(exitCode).toBe(0);
    // Earliest admin (dave) owns it — not the earlier member, not the later admin.
    expect(existsSync(identityBlob("usr_dave", "fl_bbbbbbbbbbbbbbbbbbbbbbbb", "deck.pdf"))).toBe(true);
    const reg = await readDestRegistry("usr_dave");
    expect(reg[0]?.workspaceId).toBe("ws_team0000000001");
  });

  test("tombstoned files are skipped", async () => {
    await seedWorkspace({ wsId: "ws_user_usr_alice", isPersonal: true, ownerUserId: "usr_alice" });
    await seedFile({
      wsId: "ws_user_usr_alice",
      id: "fl_cccccccccccccccccccccccc",
      filename: "gone.txt",
      deleted: true,
    });

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("tombstoned (skip):   1");
    expect(existsSync(join(workDir, "users", "usr_alice", "files"))).toBe(false);
  });

  test("idempotent: a second run migrates nothing", async () => {
    await seedWorkspace({ wsId: "ws_user_usr_alice", isPersonal: true, ownerUserId: "usr_alice" });
    await seedFile({ wsId: "ws_user_usr_alice", id: "fl_dddddddddddddddddddddddd", filename: "a.txt" });

    const first = await runMigrate();
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain("migrated:            1");

    const second = await runMigrate();
    expect(second.exitCode).toBe(0);
    expect(second.stderr).toContain("migrated:            0");
    // No duplicate registry line.
    expect(await readDestRegistry("usr_alice")).toHaveLength(1);
  });

  test("dry-run writes nothing", async () => {
    await seedWorkspace({ wsId: "ws_user_usr_alice", isPersonal: true, ownerUserId: "usr_alice" });
    await seedFile({ wsId: "ws_user_usr_alice", id: "fl_eeeeeeeeeeeeeeeeeeeeeeee", filename: "a.txt" });

    const { exitCode, stderr } = await runMigrate(["--dry-run"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("would move");
    expect(existsSync(join(workDir, "users", "usr_alice", "files"))).toBe(false);
    // Source untouched.
    expect(
      existsSync(join(workDir, "workspaces", "ws_user_usr_alice", "files", "fl_eeeeeeeeeeeeeeeeeeeeeeee_a.txt")),
    ).toBe(true);
  });

  test("FATAL: team workspace with no admin", async () => {
    await seedWorkspace({
      wsId: "ws_team0000000002",
      members: [{ userId: "usr_frank", role: "member" }],
    });
    await seedFile({ wsId: "ws_team0000000002", id: "fl_ffffffffffffffffffffffff", filename: "x.txt" });

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(2);
    expect(stderr).toContain("[FATAL]");
    expect(stderr).toContain("no resolvable owner");
    // Nothing moved.
    expect(existsSync(join(workDir, "users"))).toBe(false);
  });

  test("FATAL: the same file id under two workspaces", async () => {
    await seedWorkspace({ wsId: "ws_user_usr_alice", isPersonal: true, ownerUserId: "usr_alice" });
    await seedWorkspace({ wsId: "ws_user_usr_bob", isPersonal: true, ownerUserId: "usr_bob" });
    const dupe = "fl_999999999999999999999999";
    await seedFile({ wsId: "ws_user_usr_alice", id: dupe, filename: "a.txt" });
    await seedFile({ wsId: "ws_user_usr_bob", id: dupe, filename: "b.txt" });

    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(2);
    expect(stderr).toContain("[FATAL]");
    expect(stderr).toContain("multiple workspaces");
    expect(existsSync(join(workDir, "users"))).toBe(false);
  });
});
