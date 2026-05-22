/**
 * Exercises scripts/migrate-user-creds-to-personal-workspace.ts against
 * a fake work tree. Classified as integration because it spawns `bun` on
 * the script.
 *
 * Test cases mirror the task spec's "Tests Required" list:
 *   1. Happy path — two users, files move, sources removed.
 *   2. Idempotent re-run — second --apply produces zero moves, exits 0.
 *   3. Partial-rename heal — one user already at dest, one still at src.
 *   4. Same-FS pre-flight error path — forced EXDEV exits non-zero.
 *   5. Conflict refusal — divergent contents, exit non-zero, no writes.
 *   6. Lock contention — live PID holder makes the run fail fast.
 *   7. Stale-lock takeover — dead PID is reclaimed transparently.
 *   8. Dry-run is read-only — workdir byte-identical before/after.
 *   9. Helper-only id construction — no `"ws_user_"` literals in script.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const SCRIPT = join(
  import.meta.dirname ?? __dirname,
  "..",
  "..",
  "scripts",
  "migrate-user-creds-to-personal-workspace.ts",
);

// Same sentinel pattern as test/integration/migration-lock.test.ts — far
// above any platform's max PID so kill(0) reliably returns ESRCH.
const DEFINITELY_DEAD_PID = 2147483647;

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-migrate-creds-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Seed a credential file at `users/<userId>/credentials/<relPath>`.
 * Returns the absolute path it was written to.
 */
async function seedUserCred(userId: string, relPath: string, content: string): Promise<string> {
  const abs = join(workDir, "users", userId, "credentials", relPath);
  await mkdir(join(abs, ".."), { recursive: true, mode: 0o700 });
  await writeFile(abs, content, { mode: 0o600 });
  return abs;
}

/**
 * Seed a credential file at the destination side:
 * `workspaces/ws_user_<userId>/credentials/<relPath>`.
 */
async function seedWorkspaceCred(
  userId: string,
  relPath: string,
  content: string,
): Promise<string> {
  const abs = join(
    workDir,
    "workspaces",
    `ws_user_${userId}`,
    "credentials",
    relPath,
  );
  await mkdir(join(abs, ".."), { recursive: true, mode: 0o700 });
  await writeFile(abs, content, { mode: 0o600 });
  return abs;
}

function workspaceCredsPath(userId: string, relPath: string): string {
  return join(workDir, "workspaces", `ws_user_${userId}`, "credentials", relPath);
}

function userCredsPath(userId: string, relPath: string): string {
  return join(workDir, "users", userId, "credentials", relPath);
}

async function runMigrate(
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", "run", SCRIPT, "--work-dir", workDir, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stderr, stdout, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
}

/**
 * Walk workDir and produce a sorted map of {relPath -> sha256(content)}.
 * Used by the dry-run read-only test to assert byte-identity before/after.
 */
async function snapshotWorkDir(): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(abs);
      } else if (entry.isFile()) {
        const buf = await readFile(abs);
        // Bun supports the crypto Web API.
        const digest = await crypto.subtle.digest("SHA-256", buf);
        const hex = Buffer.from(digest).toString("hex");
        snapshot.set(relative(workDir, abs), hex);
      }
    }
  }

  await visit(workDir);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("migrate-user-creds-to-personal-workspace", () => {
  test("happy path: two users with cred files → --apply moves both", async () => {
    await seedUserCred("user_one", "mcp-oauth/server-a/tokens.json", '{"access":"one-a"}');
    await seedUserCred("user_one", "mcp-oauth/server-a/client.json", '{"client":"one-a"}');
    await seedUserCred("user_two", "mcp-oauth/server-b/tokens.json", '{"access":"two-b"}');

    const { exitCode, stderr } = await runMigrate(["--apply"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("total moved:                   3");
    expect(stderr).toContain("total conflicts:               0");

    // Destinations have the correct contents.
    expect(
      await readFile(workspaceCredsPath("user_one", "mcp-oauth/server-a/tokens.json"), "utf-8"),
    ).toBe('{"access":"one-a"}');
    expect(
      await readFile(workspaceCredsPath("user_one", "mcp-oauth/server-a/client.json"), "utf-8"),
    ).toBe('{"client":"one-a"}');
    expect(
      await readFile(workspaceCredsPath("user_two", "mcp-oauth/server-b/tokens.json"), "utf-8"),
    ).toBe('{"access":"two-b"}');

    // Sources are gone — both the files AND the now-empty credentials/ dir.
    expect(existsSync(userCredsPath("user_one", "mcp-oauth/server-a/tokens.json"))).toBe(false);
    expect(existsSync(userCredsPath("user_two", "mcp-oauth/server-b/tokens.json"))).toBe(false);
    expect(existsSync(join(workDir, "users", "user_one", "credentials"))).toBe(false);
    expect(existsSync(join(workDir, "users", "user_two", "credentials"))).toBe(false);

    // The parent users/<userId>/ directories stay (other pre-Stage-3 data
    // may live there). This is in the spec's acceptance criteria.
    expect(existsSync(join(workDir, "users", "user_one"))).toBe(true);
    expect(existsSync(join(workDir, "users", "user_two"))).toBe(true);
  });

  test("idempotent: second --apply produces zero new moves and exits 0", async () => {
    // Pins the failure mode the spec calls out: a naive `rename` that
    // throws on missing source would fail the second run.
    await seedUserCred("user_alpha", "mcp-oauth/svc/tokens.json", '{"a":"b"}');

    const first = await runMigrate(["--apply"]);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toContain("total moved:                   1");

    const second = await runMigrate(["--apply"]);
    expect(second.exitCode).toBe(0);
    expect(second.stderr).toContain("total moved:                   0");
    expect(second.stderr).toContain("total conflicts:               0");
    expect(second.stderr).toContain("total skipped (already migrated): 0");
    // Second run sees no source dir at all because the first run removed it.
    expect(existsSync(join(workDir, "users", "user_alpha", "credentials"))).toBe(false);
    // Destination still has the file.
    expect(existsSync(workspaceCredsPath("user_alpha", "mcp-oauth/svc/tokens.json"))).toBe(true);
  });

  test("partial-rename heal: one user pre-migrated, one still at source", async () => {
    // Pre-stage user_one as already migrated, byte-identical at dest.
    // user_two has files only at the source.
    const sameBytes = '{"identical":true}';
    await seedWorkspaceCred("user_one", "mcp-oauth/svc/tokens.json", sameBytes);
    await seedUserCred("user_one", "mcp-oauth/svc/tokens.json", sameBytes);

    await seedUserCred("user_two", "mcp-oauth/svc/tokens.json", '{"two":"src"}');

    const { exitCode, stderr } = await runMigrate(["--apply"]);
    expect(exitCode).toBe(0);
    // user_one's file: identical bytes → skipped, stale source removed.
    expect(stderr).toContain("total skipped (already migrated): 1");
    // user_two's file: normal move.
    expect(stderr).toContain("total moved:                   1");
    expect(stderr).toContain("total conflicts:               0");

    // user_one: source removed, destination preserved.
    expect(existsSync(userCredsPath("user_one", "mcp-oauth/svc/tokens.json"))).toBe(false);
    expect(
      await readFile(workspaceCredsPath("user_one", "mcp-oauth/svc/tokens.json"), "utf-8"),
    ).toBe(sameBytes);

    // user_two: moved.
    expect(existsSync(userCredsPath("user_two", "mcp-oauth/svc/tokens.json"))).toBe(false);
    expect(
      await readFile(workspaceCredsPath("user_two", "mcp-oauth/svc/tokens.json"), "utf-8"),
    ).toBe('{"two":"src"}');
  });

  test("same-FS pre-flight error: forced EXDEV exits non-zero, no files moved", async () => {
    // The integration harness can't portably stage two filesystems, so
    // the script exposes NB_MIGRATE_FORCE_EXDEV=1 to drive the
    // error-path code. The user-facing message is what we lock down.
    await seedUserCred("user_beta", "mcp-oauth/svc/tokens.json", "irrelevant");

    const { exitCode, stderr } = await runMigrate(["--apply"], {
      NB_MIGRATE_FORCE_EXDEV: "1",
    });
    expect(exitCode).toBe(2);
    expect(stderr).toContain("[FATAL]");
    expect(stderr).toContain("different filesystems");
    expect(stderr).toContain("EXDEV");

    // Nothing was moved.
    expect(existsSync(userCredsPath("user_beta", "mcp-oauth/svc/tokens.json"))).toBe(true);
    expect(existsSync(workspaceCredsPath("user_beta", "mcp-oauth/svc/tokens.json"))).toBe(false);
  });

  test("conflict refusal: both sides differ → exit non-zero, neither modified", async () => {
    await seedUserCred("user_gamma", "mcp-oauth/svc/tokens.json", '{"side":"source"}');
    await seedWorkspaceCred("user_gamma", "mcp-oauth/svc/tokens.json", '{"side":"dest"}');

    const { exitCode, stderr } = await runMigrate(["--apply"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("[CONFLICT]");
    expect(stderr).toContain("user_gamma/mcp-oauth/svc/tokens.json");
    expect(stderr).toContain("total conflicts:               1");
    expect(stderr).toContain("operator reconciliation");

    // Neither side modified.
    expect(
      await readFile(userCredsPath("user_gamma", "mcp-oauth/svc/tokens.json"), "utf-8"),
    ).toBe('{"side":"source"}');
    expect(
      await readFile(workspaceCredsPath("user_gamma", "mcp-oauth/svc/tokens.json"), "utf-8"),
    ).toBe('{"side":"dest"}');
  });

  test("lock contention: a live holder makes the run fail fast with the holder's PID", async () => {
    await seedUserCred("user_delta", "mcp-oauth/svc/tokens.json", "x");

    // Plant a live lock pointing at this test process — same pattern
    // heal-truncated-personal-workspaces.test.ts uses.
    const lockPath = join(workDir, ".migration-lock");
    await writeFile(
      lockPath,
      `${JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          script: "fake-holder",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const { exitCode, stderr } = await runMigrate(["--apply"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Another migration is already running");
    expect(stderr).toContain("fake-holder");
    expect(stderr).toContain(`pid=${process.pid}`);

    // Nothing was touched.
    expect(existsSync(userCredsPath("user_delta", "mcp-oauth/svc/tokens.json"))).toBe(true);
    expect(existsSync(workspaceCredsPath("user_delta", "mcp-oauth/svc/tokens.json"))).toBe(false);

    // The lock still belongs to us — the failed run didn't clobber it.
    const cur = JSON.parse(await readFile(lockPath, "utf-8")) as { pid: number };
    expect(cur.pid).toBe(process.pid);
  });

  test("stale-lock takeover: a dead-PID lock is reclaimed transparently", async () => {
    await seedUserCred("user_epsilon", "mcp-oauth/svc/tokens.json", "y");

    const lockPath = join(workDir, ".migration-lock");
    await writeFile(
      lockPath,
      `${JSON.stringify(
        {
          pid: DEFINITELY_DEAD_PID,
          startedAt: new Date().toISOString(),
          script: "ghost",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );

    const { exitCode, stderr } = await runMigrate(["--apply"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("stale lock");
    expect(stderr).toContain("taking over");
    expect(stderr).toContain("total moved:                   1");

    // The migration actually completed.
    expect(existsSync(workspaceCredsPath("user_epsilon", "mcp-oauth/svc/tokens.json"))).toBe(true);
    // Lock cleared on exit.
    expect(existsSync(lockPath)).toBe(false);
  });

  test("dry-run is the default, reports the plan, and writes nothing", async () => {
    await seedUserCred("user_zeta", "mcp-oauth/svc/tokens.json", '{"hello":"world"}');
    await seedUserCred("user_eta", "mcp-oauth/svc/refresh.json", '{"refresh":"abc"}');

    const before = await snapshotWorkDir();

    // Default is dry-run (per the spec).
    const { exitCode, stderr } = await runMigrate();
    expect(exitCode).toBe(0);
    expect(stderr).toContain("(dry-run)");
    expect(stderr).toContain("[dry-run] would move");
    expect(stderr).toContain("total moved:                   2");

    // Workdir is byte-identical before and after.
    const after = await snapshotWorkDir();
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());

    // Sources untouched, destinations not created.
    expect(existsSync(userCredsPath("user_zeta", "mcp-oauth/svc/tokens.json"))).toBe(true);
    expect(existsSync(workspaceCredsPath("user_zeta", "mcp-oauth/svc/tokens.json"))).toBe(false);
  });

  test("dry-run on a fully-migrated workdir reports zero pending moves", async () => {
    // Pre-migrate user_theta to canonical state: only at the destination.
    await seedWorkspaceCred("user_theta", "mcp-oauth/svc/tokens.json", '{"done":true}');
    // And the source users/<id>/ exists (it does in production: profile.json
    // etc. live there) but no credentials/ subtree.
    await mkdir(join(workDir, "users", "user_theta"), { recursive: true });
    await writeFile(join(workDir, "users", "user_theta", "profile.json"), "{}");

    const { exitCode, stderr } = await runMigrate(["--dry-run"]);
    expect(exitCode).toBe(0);
    expect(stderr).toContain("total moved:                   0");
    expect(stderr).toContain("total conflicts:               0");
  });

  test("personal workspace id is built only via personalWorkspaceIdFor — no `ws_user_` literal in the script", () => {
    // Stage 1 lesson: hand-built workspace ids regressed once. This
    // grep-style assertion locks down the source itself, complementing
    // the `check:personal-workspace-id` lint (which scans src/, not
    // scripts/).
    const source = readFileSync(SCRIPT, "utf-8");
    // Strip comments / docstrings so we only check executable code.
    // A naive approach is fine for an OSS migration script: find any
    // `"ws_user_"` or `` `ws_user_` `` literal anywhere outside line
    // comments and JSDoc blocks.
    const stripped = source
      // Block comments.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // Line comments.
      .replace(/(^|\s)\/\/.*$/gm, "");
    // The string `ws_user_` must NOT appear in executable code.
    expect(stripped).not.toMatch(/["'`]ws_user_/);
    expect(stripped).not.toContain('"ws_user_"');
    // Sanity: confirm the helper is imported.
    expect(source).toContain("personalWorkspaceIdFor");
    expect(source).toContain('from "../src/workspace/workspace-store.ts"');
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
    expect(stdout).toContain("migrate-user-creds-to-personal-workspace");
    expect(stdout).toContain("--apply");
    expect(stdout).toContain("--dry-run");
    expect(stdout).toContain("--work-dir");
  });

  test("destination cred files preserve their content type (binary safe)", async () => {
    // Tokens, client.json, etc. are JSON in practice; this is a guard
    // that a future binary-blob credential type doesn't get silently
    // mangled by the move. Use a byte sequence that's invalid UTF-8.
    const userId = "user_iota";
    const rel = "mcp-oauth/svc/blob.bin";
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0xfd, 0xfc, 0x80, 0x81]);
    const srcAbs = join(workDir, "users", userId, "credentials", rel);
    await mkdir(join(srcAbs, ".."), { recursive: true, mode: 0o700 });
    await writeFile(srcAbs, bytes, { mode: 0o600 });

    const { exitCode } = await runMigrate(["--apply"]);
    expect(exitCode).toBe(0);

    const dstBytes = await readFile(workspaceCredsPath(userId, rel));
    expect(dstBytes.equals(bytes)).toBe(true);

    // File mode preserved by rename(2) — sanity check, not a hard contract.
    const s = await stat(workspaceCredsPath(userId, rel));
    expect(s.mode & 0o777).toBe(0o600);
  });
});
