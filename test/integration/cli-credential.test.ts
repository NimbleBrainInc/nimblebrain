import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "bun";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Happy-path coverage for the `nb credential` subcommands. The CLI is
 * the first-line operator UX for seeding `oauthClient.clientSecret`
 * references — bugs here surface only on operator deploy. The
 * underlying `FileCredentialStore` has unit coverage; these tests are
 * the thin-wrapper end of that.
 *
 * Each test gets its own temp work-dir via `--work-dir` so the suite
 * is hermetic and can run concurrently.
 */

const CLI = "src/cli/index.ts";
const WS_ID = "ws_test";

function run(args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode ?? 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("nb credential", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-cred-cli-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("set writes a secret to <workDir>/workspaces/<wsId>/credentials/secrets/<key> with mode 0o600", () => {
    const result = run([
      "credential",
      "set",
      WS_ID,
      "asana.client_secret",
      "supersecret",
      "--work-dir",
      workDir,
    ]);
    expect(result.code).toBe(0);

    const file = join(workDir, "workspaces", WS_ID, "credentials", "secrets", "asana.client_secret");
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("get round-trips the value via stdout (no trailing newline, designed for piping)", () => {
    run([
      "credential",
      "set",
      WS_ID,
      "hubspot.client_secret",
      "rotate-me",
      "--work-dir",
      workDir,
    ]);
    const result = run([
      "credential",
      "get",
      WS_ID,
      "hubspot.client_secret",
      "--work-dir",
      workDir,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("rotate-me");
  });

  it("get exits non-zero when the key is missing", () => {
    const result = run(["credential", "get", WS_ID, "missing.key", "--work-dir", workDir]);
    expect(result.code).toBe(1);
    // Diagnostic to stderr; stdout stays clean for piping consumers.
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not found");
  });

  it("list shows seeded keys and never the values", () => {
    run(["credential", "set", WS_ID, "google.client_secret", "g-secret", "--work-dir", workDir]);
    run(["credential", "set", WS_ID, "asana.client_secret", "a-secret", "--work-dir", workDir]);
    const result = run(["credential", "list", WS_ID, "--work-dir", workDir]);
    expect(result.code).toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toContain("google.client_secret");
    expect(out).toContain("asana.client_secret");
    expect(out).not.toContain("g-secret");
    expect(out).not.toContain("a-secret");
  });

  it("delete removes the file (and is idempotent on a missing key)", () => {
    run(["credential", "set", WS_ID, "zoom.client_secret", "z-secret", "--work-dir", workDir]);
    const file = join(workDir, "workspaces", WS_ID, "credentials", "secrets", "zoom.client_secret");
    expect(existsSync(file)).toBe(true);

    const first = run(["credential", "delete", WS_ID, "zoom.client_secret", "--work-dir", workDir]);
    expect(first.code).toBe(0);
    expect(existsSync(file)).toBe(false);

    // Idempotent — second delete on the same key still exits 0.
    const second = run(["credential", "delete", WS_ID, "zoom.client_secret", "--work-dir", workDir]);
    expect(second.code).toBe(0);
  });

  it("set then delete then get exits non-zero (full lifecycle)", () => {
    run(["credential", "set", WS_ID, "outlook.client_secret", "o-secret", "--work-dir", workDir]);
    run(["credential", "delete", WS_ID, "outlook.client_secret", "--work-dir", workDir]);
    const result = run([
      "credential",
      "get",
      WS_ID,
      "outlook.client_secret",
      "--work-dir",
      workDir,
    ]);
    expect(result.code).toBe(1);
  });
});
