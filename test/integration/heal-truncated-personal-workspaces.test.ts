/**
 * Exercises scripts/heal-truncated-personal-workspaces.ts against a
 * fake work tree. Each test names the failure mode it pins — adversarial
 * cases caught Stage 1 lessons (no silent auto-merging, no name guessing,
 * no membership guessing).
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const SCRIPT = join(
  import.meta.dirname ?? __dirname,
  "..",
  "..",
  "scripts",
  "heal-truncated-personal-workspaces.ts",
);

// A real-shaped userId so the 16-char truncation differs from the full
// ULID. `user_<26-char-ULID>` is the canonical form.
const USER_ID = "user_01kp730nhbcj3ck2hfhe3hmnf6";
const DISPLAY_NAME = "Alice";
// Truncated form: 16 chars of the ULID after stripping `user_`.
const TRUNCATED_WS_ID = "ws_01kp730nhbcj3ck2";
// Canonical form (personalWorkspaceIdFor): `ws_user_<userId>`.
const CANONICAL_WS_ID = `ws_user_${USER_ID}`;
const EXPECTED_NAME = `${DISPLAY_NAME}'s Workspace`;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-heal-trunc-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function seedUser(
  id: string = USER_ID,
  email = "alice@example.com",
  displayName: string = DISPLAY_NAME,
): Promise<void> {
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
  bundles?: unknown[];
  isPersonal?: boolean;
  ownerUserId?: string;
  about?: string | null;
}): Promise<void> {
  const wsDir = join(workDir, "workspaces", opts.id);
  await mkdir(wsDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const ws: Record<string, unknown> = {
    id: opts.id,
    name: opts.name,
    members: opts.members,
    bundles: opts.bundles ?? [],
    createdAt: now,
    updatedAt: now,
  };
  if (opts.isPersonal !== undefined) ws.isPersonal = opts.isPersonal;
  if (opts.ownerUserId !== undefined) ws.ownerUserId = opts.ownerUserId;
  if (opts.about !== undefined) ws.about = opts.about;
  await writeFile(join(wsDir, "workspace.json"), `${JSON.stringify(ws, null, 2)}\n`);
}

async function seedTopLevelConversation(opts: {
  convId: string;
  workspaceId: string;
  ownerId?: string;
}): Promise<void> {
  const dir = join(workDir, "conversations");
  await mkdir(dir, { recursive: true });
  const metadata = {
    id: opts.convId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    title: null,
    lastModel: null,
    ownerId: opts.ownerId ?? USER_ID,
    workspaceId: opts.workspaceId,
    format: "events",
  };
  const body =
    `${JSON.stringify(metadata)}\n` +
    `${JSON.stringify({ ts: new Date().toISOString(), type: "user.message", content: [{ type: "text", text: "hi" }] })}\n`;
  await writeFile(join(dir, `${opts.convId}.jsonl`), body);
}

async function readWorkspace(id: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(workDir, "workspaces", id, "workspace.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

async function readConvMetadata(convId: string): Promise<Record<string, unknown>> {
  const raw = await readFile(
    join(workDir, "conversations", `${convId}.jsonl`),
    "utf-8",
  );
  const firstLine = raw.split("\n")[0] ?? "";
  return JSON.parse(firstLine) as Record<string, unknown>;
}

async function runHeal(args: string[] = []): Promise<{ exitCode: number; stderr: string }> {
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

/**
 * Deep-snapshot the workdir: per-file relative-path → SHA-256 of bytes.
 * Used to verify dry-run is byte-identical (no observable mutation).
 */
async function snapshotWorkdir(): Promise<Map<string, string>> {
  const snap = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile()) {
        const bytes = await readFile(full);
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(bytes);
        snap.set(relative(workDir, full), hasher.digest("hex"));
      }
    }
  }
  await walk(workDir);
  return snap;
}

describe("heal-truncated-personal-workspaces", () => {
  test("happy path: deletes empty canonical stub, renames truncated → canonical, stamps identity, rewrites conv refs", async () => {
    await seedUser();
    // Personal workspace at the truncated id with the correct name +
    // admin membership.
    await seedWorkspace({
      id: TRUNCATED_WS_ID,
      name: EXPECTED_NAME,
      members: [{ userId: USER_ID, role: "admin" }],
    });
    // An empty canonical stub left by Stage 1's lazy-create or by a
    // misclassified backfill.
    await seedWorkspace({
      id: CANONICAL_WS_ID,
      name: "Personal",
      members: [{ userId: USER_ID, role: "admin" }],
      bundles: [],
    });
    // A conversation that still points at the truncated workspace id.
    await seedTopLevelConversation({
      convId: "conv_alpha",
      workspaceId: TRUNCATED_WS_ID,
    });

    const { exitCode, stderr } = await runHeal();
    expect(exitCode).toBe(0);
    expect(stderr).toContain(`delete empty canonical stub ${CANONICAL_WS_ID}`);
    expect(stderr).toContain(`rename ${TRUNCATED_WS_ID} → ${CANONICAL_WS_ID}`);
    expect(stderr).toContain("rewrite workspaceId on 1 conversation(s)");

    // Truncated gone, canonical exists.
    expect(existsSync(join(workDir, "workspaces", TRUNCATED_WS_ID))).toBe(false);
    expect(existsSync(join(workDir, "workspaces", CANONICAL_WS_ID))).toBe(true);

    // Identity stamps + id rewrite on the canonical workspace.json.
    const ws = await readWorkspace(CANONICAL_WS_ID);
    expect(ws.id).toBe(CANONICAL_WS_ID);
    expect(ws.isPersonal).toBe(true);
    expect(ws.ownerUserId).toBe(USER_ID);
    expect(ws.about).toBeNull();
    expect(ws.name).toBe(EXPECTED_NAME);

    // Conversation metadata rewritten; other lines preserved.
    const meta = await readConvMetadata("conv_alpha");
    expect(meta.workspaceId).toBe(CANONICAL_WS_ID);
    const raw = await readFile(
      join(workDir, "conversations", "conv_alpha.jsonl"),
      "utf-8",
    );
    expect(raw).toContain('"type":"user.message"');
    expect(raw).toContain('"text":"hi"');
  });

  test("no canonical stub: just rename + stamp, no error", async () => {
    await seedUser();
    await seedWorkspace({
      id: TRUNCATED_WS_ID,
      name: EXPECTED_NAME,
      members: [{ userId: USER_ID, role: "admin" }],
    });
    expect(existsSync(join(workDir, "workspaces", CANONICAL_WS_ID))).toBe(false);

    const { exitCode, stderr } = await runHeal();
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("delete empty canonical stub");
    expect(stderr).toContain(`rename ${TRUNCATED_WS_ID} → ${CANONICAL_WS_ID}`);

    expect(existsSync(join(workDir, "workspaces", TRUNCATED_WS_ID))).toBe(false);
    const ws = await readWorkspace(CANONICAL_WS_ID);
    expect(ws.id).toBe(CANONICAL_WS_ID);
    expect(ws.isPersonal).toBe(true);
    expect(ws.ownerUserId).toBe(USER_ID);
  });

  test("adversarial: canonical stub has bundles → script refuses, leaves both workspaces untouched", async () => {
    // Pins the "don't silently clobber state" invariant. A naive port
    // that rm-rf'd the canonical dir whenever it existed would lose
    // an admin's app installs.
    await seedUser();
    await seedWorkspace({
      id: TRUNCATED_WS_ID,
      name: EXPECTED_NAME,
      members: [{ userId: USER_ID, role: "admin" }],
    });
    await seedWorkspace({
      id: CANONICAL_WS_ID,
      name: "Personal",
      members: [{ userId: USER_ID, role: "admin" }],
      bundles: [
        { source: { type: "static", name: "fake-bundle" } } as unknown,
      ],
    });

    const before = await snapshotWorkdir();
    const { exitCode, stderr } = await runHeal();

    expect(exitCode).toBe(1);
    expect(stderr).toContain("canonical stub");
    expect(stderr).toContain("manual reconciliation required");

    // Both directories still present, bytes unchanged.
    const after = await snapshotWorkdir();
    expect(after.size).toBe(before.size);
    for (const [path, hash] of before) {
      expect(after.get(path)).toBe(hash);
    }
  });

  test("adversarial: name mismatch → that user is skipped", async () => {
    // Pins the "don't guess the personal owner from id shape alone"
    // invariant. A workspace at the truncated id whose name isn't
    // `<displayName>'s Workspace` could be anything; do not assume.
    await seedUser();
    await seedWorkspace({
      id: TRUNCATED_WS_ID,
      name: "Shared Team Workspace", // NOT "Alice's Workspace"
      members: [{ userId: USER_ID, role: "admin" }],
    });

    const before = await snapshotWorkdir();
    const { exitCode, stderr } = await runHeal();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("not a personal workspace");
    expect(stderr).toContain("skipped (name mismatch)");

    const after = await snapshotWorkdir();
    expect(after.size).toBe(before.size);
    for (const [path, hash] of before) {
      expect(after.get(path)).toBe(hash);
    }
  });

  test("adversarial: user is not admin of the truncated workspace → skip", async () => {
    // Pins "membership check is required". A user could be a plain
    // member on a workspace that happens to live at their truncated
    // id; healing it would steal it from its real owner.
    await seedUser();
    await seedWorkspace({
      id: TRUNCATED_WS_ID,
      name: EXPECTED_NAME,
      members: [
        { userId: USER_ID, role: "member" },
        { userId: "user_other", role: "admin" },
      ],
    });

    const before = await snapshotWorkdir();
    const { exitCode, stderr } = await runHeal();
    expect(exitCode).toBe(0);
    expect(stderr).toContain(`not admin of ${TRUNCATED_WS_ID}`);

    const after = await snapshotWorkdir();
    expect(after.size).toBe(before.size);
    for (const [path, hash] of before) {
      expect(after.get(path)).toBe(hash);
    }
  });

  test("idempotent: a second --apply run after a successful first run is a no-op", async () => {
    await seedUser();
    await seedWorkspace({
      id: TRUNCATED_WS_ID,
      name: EXPECTED_NAME,
      members: [{ userId: USER_ID, role: "admin" }],
    });
    await seedTopLevelConversation({
      convId: "conv_alpha",
      workspaceId: TRUNCATED_WS_ID,
    });

    const first = await runHeal();
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain(`rename ${TRUNCATED_WS_ID} → ${CANONICAL_WS_ID}`);

    const afterFirst = await snapshotWorkdir();

    // Mutate updatedAt to be detectable: but the script only writes if
    // it identifies a truncated personal; second run finds none.
    const second = await runHeal();
    expect(second.exitCode).toBe(0);
    expect(second.stderr).toContain("no truncated workspace");
    expect(second.stderr).not.toContain("rename");

    const afterSecond = await snapshotWorkdir();
    expect(afterSecond.size).toBe(afterFirst.size);
    for (const [path, hash] of afterFirst) {
      expect(afterSecond.get(path)).toBe(hash);
    }
  });

  test("dry-run: workdir is byte-identical before and after", async () => {
    await seedUser();
    await seedWorkspace({
      id: TRUNCATED_WS_ID,
      name: EXPECTED_NAME,
      members: [{ userId: USER_ID, role: "admin" }],
    });
    await seedWorkspace({
      id: CANONICAL_WS_ID,
      name: "Personal",
      members: [{ userId: USER_ID, role: "admin" }],
      bundles: [],
    });
    await seedTopLevelConversation({
      convId: "conv_alpha",
      workspaceId: TRUNCATED_WS_ID,
    });

    const before = await snapshotWorkdir();
    const { exitCode, stderr } = await runHeal(["--dry-run"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("[dry-run] would rename");
    expect(stderr).toContain("[dry-run] would delete empty canonical stub");
    expect(stderr).toContain("[dry-run] would rewrite workspaceId on 1 conversation(s)");

    const after = await snapshotWorkdir();
    expect(after.size).toBe(before.size);
    for (const [path, hash] of before) {
      expect(after.get(path)).toBe(hash);
    }
  });

  test("lock contention: second --apply while a first holds the lock fails fast with holder details", async () => {
    await seedUser();
    await seedWorkspace({
      id: TRUNCATED_WS_ID,
      name: EXPECTED_NAME,
      members: [{ userId: USER_ID, role: "admin" }],
    });

    // Plant a live lock pointing at this test process (which is alive).
    const lockPath = join(workDir, ".migration-lock");
    await writeFile(
      lockPath,
      `${JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          script: "migrate-personal-workspaces",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const { exitCode, stderr } = await runHeal();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Another migration is already running");
    expect(stderr).toContain("migrate-personal-workspaces");
    expect(stderr).toContain(`pid=${process.pid}`);

    // The truncated workspace was not touched.
    expect(existsSync(join(workDir, "workspaces", TRUNCATED_WS_ID))).toBe(true);
    expect(existsSync(join(workDir, "workspaces", CANONICAL_WS_ID))).toBe(false);

    // Clean up the plant so afterEach doesn't trip on it (rm -rf would
    // succeed regardless; this is just hygiene). Also confirms the lock
    // still belongs to us — the failed run didn't take it over.
    const cur = JSON.parse(await readFile(lockPath, "utf-8")) as { pid: number };
    expect(cur.pid).toBe(process.pid);
    await stat(lockPath); // throws if missing — sanity
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
    expect(stdout).toContain("heal-truncated-personal-workspaces");
    expect(stdout).toContain("--work-dir");
    expect(stdout).toContain("--dry-run");
  });
});
