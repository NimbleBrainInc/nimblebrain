import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  bundleSlug,
  clearAllWorkspaceCredentials,
  clearWorkspaceCredential,
  credentialPath,
  getWorkspaceCredentials,
  saveWorkspaceCredential,
} from "../../src/config/workspace-credentials.ts";

const BUNDLE = "@nimblebraininc/newsapi";
const WS_A = "ws_alpha";
const WS_B = "ws_beta";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-creds-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── bundleSlug ────────────────────────────────────────────────────

describe("bundleSlug", () => {
  test("scoped bundle: @scope/name → scope-name", () => {
    expect(bundleSlug("@nimblebraininc/newsapi")).toBe("nimblebraininc-newsapi");
  });

  test("unscoped bundle: name → name", () => {
    expect(bundleSlug("newsapi")).toBe("newsapi");
  });

  test("preserves hyphens in bundle names", () => {
    expect(bundleSlug("@acme/cool-tool")).toBe("acme-cool-tool");
  });
});

// ── credentialPath ────────────────────────────────────────────────

describe("credentialPath", () => {
  test("builds {workDir}/workspaces/{wsId}/credentials/{slug}.json", () => {
    const p = credentialPath(WS_A, BUNDLE, "/tmp/work");
    expect(p).toBe("/tmp/work/workspaces/ws_alpha/credentials/nimblebraininc-newsapi.json");
  });
});

// ── Save + retrieve roundtrip ─────────────────────────────────────

describe("save + get roundtrip", () => {
  test("saving then getting returns the same map", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
    const got = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(got).toEqual({ api_key: "sk-abc" });
  });

  test("returns null when the credential file does not exist", async () => {
    const got = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(got).toBeNull();
  });

  test("returns null for a workspace that has other bundles but not this one", async () => {
    await saveWorkspaceCredential(WS_A, "@acme/other", "api_key", "sk-other", workDir);
    const got = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(got).toBeNull();
  });

  test("overwrites the same key when saved twice", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-old", workDir);
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-new", workDir);
    const got = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(got).toEqual({ api_key: "sk-new" });
  });
});

// ── Merge semantics ───────────────────────────────────────────────

describe("merge semantics", () => {
  test("saving a second key preserves the first", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
    await saveWorkspaceCredential(WS_A, BUNDLE, "workspace_id", "ws-xyz", workDir);

    const got = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(got).toEqual({ api_key: "sk-abc", workspace_id: "ws-xyz" });
  });
});

// ── Workspace isolation ───────────────────────────────────────────

describe("workspace isolation", () => {
  test("same bundle in different workspaces has independent credentials", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-alpha", workDir);
    await saveWorkspaceCredential(WS_B, BUNDLE, "api_key", "sk-beta", workDir);

    const a = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    const b = await getWorkspaceCredentials(WS_B, BUNDLE, workDir);
    expect(a).toEqual({ api_key: "sk-alpha" });
    expect(b).toEqual({ api_key: "sk-beta" });
  });

  test("clearing one workspace does not affect the other", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-alpha", workDir);
    await saveWorkspaceCredential(WS_B, BUNDLE, "api_key", "sk-beta", workDir);

    await clearAllWorkspaceCredentials(WS_A, BUNDLE, workDir);

    expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toBeNull();
    expect(await getWorkspaceCredentials(WS_B, BUNDLE, workDir)).toEqual({
      api_key: "sk-beta",
    });
  });
});

// ── clearWorkspaceCredential ──────────────────────────────────────

describe("clearWorkspaceCredential", () => {
  test("removes a single key and leaves others intact; returns true", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
    await saveWorkspaceCredential(WS_A, BUNDLE, "workspace_id", "ws-xyz", workDir);

    const removed = await clearWorkspaceCredential(WS_A, BUNDLE, "api_key", workDir);
    expect(removed).toBe(true);

    const got = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(got).toEqual({ workspace_id: "ws-xyz" });
  });

  test("returns false when the key does not exist on a present file", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
    const removed = await clearWorkspaceCredential(WS_A, BUNDLE, "missing", workDir);
    expect(removed).toBe(false);
    // Other keys untouched.
    const got = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(got).toEqual({ api_key: "sk-abc" });
  });

  test("returns false when the credential file does not exist", async () => {
    const removed = await clearWorkspaceCredential(WS_A, BUNDLE, "api_key", workDir);
    expect(removed).toBe(false);
  });

  test("deletes the file entirely when the last key is removed", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
    const removed = await clearWorkspaceCredential(WS_A, BUNDLE, "api_key", workDir);
    expect(removed).toBe(true);

    // File should be gone, not an empty object.
    expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toBeNull();

    const filePath = credentialPath(WS_A, BUNDLE, workDir);
    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

// ── clearAllWorkspaceCredentials ──────────────────────────────────

describe("clearAllWorkspaceCredentials", () => {
  test("removes the entire credential file; returns true", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
    await saveWorkspaceCredential(WS_A, BUNDLE, "workspace_id", "ws-xyz", workDir);

    const removed = await clearAllWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(removed).toBe(true);

    expect(await getWorkspaceCredentials(WS_A, BUNDLE, workDir)).toBeNull();
  });

  test("returns false when the file does not exist", async () => {
    const removed = await clearAllWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(removed).toBe(false);
  });
});

// ── Security: file and directory permissions ──────────────────────

describe("permissions", () => {
  test("credential file is written with 0o600", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);

    const filePath = credentialPath(WS_A, BUNDLE, workDir);
    const st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("credential file keeps 0o600 after merge writes", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
    await saveWorkspaceCredential(WS_A, BUNDLE, "workspace_id", "ws-xyz", workDir);

    const filePath = credentialPath(WS_A, BUNDLE, workDir);
    const st = await stat(filePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test("credentials directory is created with 0o700 on first write", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);

    const dir = join(workDir, "workspaces", WS_A, "credentials");
    const st = await stat(dir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
  });
});

// ── On-disk format sanity ─────────────────────────────────────────

describe("file format", () => {
  test("is plain JSON key-value with no metadata envelope", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
    await saveWorkspaceCredential(WS_A, BUNDLE, "workspace_id", "ws-xyz", workDir);

    const raw = await readFile(credentialPath(WS_A, BUNDLE, workDir), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ api_key: "sk-abc", workspace_id: "ws-xyz" });
  });

  test("getWorkspaceCredentials ignores non-string values defensively", async () => {
    // Simulate a hand-edited file with a mixed-type value.
    const dir = join(workDir, "workspaces", WS_A, "credentials");
    await rm(dir, { recursive: true, force: true });
    // Use the public API once to create the directory with the right perms.
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);

    const filePath = credentialPath(WS_A, BUNDLE, workDir);
    await writeFile(
      filePath,
      JSON.stringify({ api_key: "sk-abc", extra: 42, also: { nested: true } }),
      { mode: 0o600 },
    );

    const got = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(got).toEqual({ api_key: "sk-abc" });
  });
});
