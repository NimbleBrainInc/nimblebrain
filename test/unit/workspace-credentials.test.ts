import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MpakConfigError } from "@nimblebrain/mpak-sdk";
import type { ConfigField, ConfirmationGate } from "../../src/config/privilege.ts";
import {
  bundleSlug,
  clearAllWorkspaceCredentials,
  clearWorkspaceCredential,
  credentialPath,
  friendlyMpakConfigError,
  getWorkspaceCredentials,
  resolveUserConfig,
  saveWorkspaceCredential,
  type UserConfigFieldDef,
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

  test("malformed JSON throws with the file path in the message", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
    const filePath = credentialPath(WS_A, BUNDLE, workDir);
    await writeFile(filePath, "{not valid json", { mode: 0o600 });

    let thrown: Error | undefined;
    try {
      await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain("failed to parse credential file");
    expect(thrown?.message).toContain(filePath);
  });

  test("non-object JSON (array) throws with the file path in the message", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);
    const filePath = credentialPath(WS_A, BUNDLE, workDir);
    await writeFile(filePath, JSON.stringify(["not", "an", "object"]), { mode: 0o600 });

    let thrown: Error | undefined;
    try {
      await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain("not a JSON object");
    expect(thrown?.message).toContain(filePath);
  });
});

// ── Insecure-mode warning ────────────────────────────────────────

describe("insecure mode warning", () => {
  test("file with 0o644 triggers a stderr warning but still returns credentials", async () => {
    // Seed via the public API (which writes 0o600) so the directory exists.
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-abc", workDir);

    // Relax the file permissions to simulate a pre-existing insecure file
    // from an older NimbleBrain version or a manual edit.
    const { chmod } = await import("node:fs/promises");
    const filePath = credentialPath(WS_A, BUNDLE, workDir);
    await chmod(filePath, 0o644);

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const creds = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
      // Advisory check: we still return the credentials even when mode is wrong.
      expect(creds).toEqual({ api_key: "sk-abc" });
    } finally {
      console.warn = origWarn;
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("insecure permissions");
    expect(warnings[0]).toContain("mode=0644");
    expect(warnings[0]).toContain(filePath);
    // Critical: the value itself must never land in the warning.
    expect(warnings[0]).not.toContain("sk-abc");
  });
});

// ── Input validation (warning #1 from QA) ─────────────────────────

describe("wsId validation", () => {
  test.each([
    ["../evil", "path-traversal"],
    ["", "empty"],
    ["not-prefixed", "missing ws_ prefix"],
    ["ws_/slash", "slash inside"],
    ["ws_.dot", "dot inside"],
    ["ws_" + "x".repeat(65), "too long"],
  ])("rejects %s (%s)", async (badWsId) => {
    await expect(saveWorkspaceCredential(badWsId, BUNDLE, "k", "v", workDir)).rejects.toThrow(
      /invalid wsId/i,
    );
    await expect(getWorkspaceCredentials(badWsId, BUNDLE, workDir)).rejects.toThrow(
      /invalid wsId/i,
    );
    await expect(clearWorkspaceCredential(badWsId, BUNDLE, "k", workDir)).rejects.toThrow(
      /invalid wsId/i,
    );
    await expect(clearAllWorkspaceCredentials(badWsId, BUNDLE, workDir)).rejects.toThrow(
      /invalid wsId/i,
    );
    expect(() => credentialPath(badWsId, BUNDLE, workDir)).toThrow(/invalid wsId/i);
  });

  test("accepts conforming wsIds", () => {
    // Spot-check a few: the regex is re-validated in workspace-store.test.ts.
    expect(() => credentialPath("ws_abc", BUNDLE, workDir)).not.toThrow();
    expect(() => credentialPath("ws_with_underscores_123", BUNDLE, workDir)).not.toThrow();
    expect(() => credentialPath("WS_UPPER", BUNDLE, workDir)).not.toThrow();
  });
});

describe("bundleName validation via bundleSlug", () => {
  test.each([
    ["..", ".. path segment"],
    [".", ". path segment"],
    ["foo\0bar", "null byte"],
    ["foo bar", "space"],
    ["foo;rm -rf /", "shell metacharacters"],
    ["", "empty"],
  ])("rejects %s (%s)", (bad) => {
    expect(() => bundleSlug(bad)).toThrow(/invalid bundle name/i);
  });

  test("path separators inside a scoped name are collapsed safely", () => {
    // This is not a valid bundle name, but we prove the slug is the right
    // defense: `/` becomes `-`, no traversal possible.
    expect(bundleSlug("@foo/bar/baz")).toBe("foo-bar-baz");
  });
});

// ── Concurrent write safety (warning #2 from QA) ──────────────────

describe("concurrent save/clear on the same bundle", () => {
  test("concurrent saves of different keys both land — no lost update", async () => {
    // Without per-file locking, two concurrent read-modify-writes both read
    // the empty starting state and one overwrites the other. With the lock,
    // both keys appear in the final file.
    await Promise.all([
      saveWorkspaceCredential(WS_A, BUNDLE, "alpha", "v-a", workDir),
      saveWorkspaceCredential(WS_A, BUNDLE, "beta", "v-b", workDir),
    ]);

    const got = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(got).toEqual({ alpha: "v-a", beta: "v-b" });
  });

  test("concurrent save + clear on different keys resolves deterministically", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "keep", "v-keep", workDir);
    await saveWorkspaceCredential(WS_A, BUNDLE, "drop", "v-drop", workDir);

    await Promise.all([
      saveWorkspaceCredential(WS_A, BUNDLE, "new", "v-new", workDir),
      clearWorkspaceCredential(WS_A, BUNDLE, "drop", workDir),
    ]);

    const got = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(got).toEqual({ keep: "v-keep", new: "v-new" });
  });

  test("high-fanout concurrent saves preserve every key", async () => {
    // Stress: 50 concurrent saves of unique keys on the same file. Without
    // serialization this fails reliably on most machines; with it, all
    // 50 keys land.
    const ops = Array.from({ length: 50 }, (_, i) =>
      saveWorkspaceCredential(WS_A, BUNDLE, `k${i}`, `v${i}`, workDir),
    );
    await Promise.all(ops);

    const got = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(got).not.toBeNull();
    expect(Object.keys(got!).length).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect(got![`k${i}`]).toBe(`v${i}`);
    }
  });

  test("writes to DIFFERENT bundles in the same workspace do not block each other", async () => {
    // Sanity check: the lock is per-file, not global. Saves to different
    // bundles should proceed in parallel (test for absence of bug, not
    // really measurable in terms of wall time at this size — just prove
    // correctness).
    await Promise.all([
      saveWorkspaceCredential(WS_A, "@acme/alpha", "k", "v1", workDir),
      saveWorkspaceCredential(WS_A, "@acme/beta", "k", "v2", workDir),
      saveWorkspaceCredential(WS_A, "@acme/gamma", "k", "v3", workDir),
    ]);

    expect(await getWorkspaceCredentials(WS_A, "@acme/alpha", workDir)).toEqual({ k: "v1" });
    expect(await getWorkspaceCredentials(WS_A, "@acme/beta", workDir)).toEqual({ k: "v2" });
    expect(await getWorkspaceCredentials(WS_A, "@acme/gamma", workDir)).toEqual({ k: "v3" });
  });
});

// ── resolveUserConfig ─────────────────────────────────────────────
//
// The resolver is intentionally narrow: read the workspace credential
// store and (in TUI `configure` mode) prompt via the gate, persisting
// responses. Everything else — mcp_config.env reverse lookup, manifest
// defaults, required-field validation — lives in the mpak SDK. These
// tests cover the host-side contract only.

function mockGate(
  opts: {
    supportsInteraction?: boolean;
    responses?: Record<string, string>;
  } = {},
): ConfirmationGate & { calls: ConfigField[] } {
  const calls: ConfigField[] = [];
  return {
    supportsInteraction: opts.supportsInteraction ?? true,
    confirm: async () => true,
    promptConfigValue: async (field) => {
      calls.push(field);
      return opts.responses?.[field.key] ?? null;
    },
    calls,
  } as ConfirmationGate & { calls: ConfigField[] };
}

describe("resolveUserConfig", () => {
  const SCHEMA: Record<string, UserConfigFieldDef> = {
    api_key: { type: "string", required: true, sensitive: true, title: "API Key" },
  };

  test("null schema → {}", async () => {
    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: null,
      wsId: WS_A,
      workDir,
    });
    expect(result).toEqual({});
  });

  test("undefined schema → {}", async () => {
    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: undefined,
      wsId: WS_A,
      workDir,
    });
    expect(result).toEqual({});
  });

  test("empty schema → {}", async () => {
    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: {},
      wsId: WS_A,
      workDir,
    });
    expect(result).toEqual({});
  });

  test("workspace store: returns stored values", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-from-store", workDir);

    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_A,
      workDir,
    });
    expect(result).toEqual({ api_key: "sk-from-store" });
  });

  test("no stored value + no gate → returns partial map (does NOT throw)", async () => {
    // The SDK is now responsible for required-field validation. The
    // resolver returns whatever it found and lets the SDK surface
    // MpakConfigError if appropriate.
    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_A,
      workDir,
    });
    expect(result).toEqual({});
  });

  test("workspace isolation: two workspaces have independent stores", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-alpha", workDir);
    await saveWorkspaceCredential(WS_B, BUNDLE, "api_key", "sk-beta", workDir);

    const a = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_A,
      workDir,
    });
    const b = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_B,
      workDir,
    });

    expect(a).toEqual({ api_key: "sk-alpha" });
    expect(b).toEqual({ api_key: "sk-beta" });
  });

  test("empty string in workspace store is treated as absent (not returned)", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "", workDir);

    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_A,
      workDir,
    });
    expect(result).toEqual({});
  });

  test("multi-field: returns only fields with non-empty stored values", async () => {
    const schema: Record<string, UserConfigFieldDef> = {
      api_key: { type: "string", required: true },
      workspace_id: { type: "string", required: false },
      region: { type: "string", required: false },
    };
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-xxx", workDir);
    await saveWorkspaceCredential(WS_A, BUNDLE, "region", "us-west", workDir);
    // workspace_id intentionally not set

    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: schema,
      wsId: WS_A,
      workDir,
    });
    expect(result).toEqual({ api_key: "sk-xxx", region: "us-west" });
  });
});

describe("resolveUserConfig — forcePrompt (TUI configure flow)", () => {
  const SCHEMA: Record<string, UserConfigFieldDef> = {
    api_key: {
      type: "string",
      required: true,
      sensitive: true,
      title: "API Key",
      description: "Your API key",
    },
  };

  test("prompts, persists to workspace store, returns prompted value", async () => {
    const gate = mockGate({ responses: { api_key: "sk-prompted" } });

    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_A,
      workDir,
      gate,
      forcePrompt: true,
    });

    expect(result).toEqual({ api_key: "sk-prompted" });
    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0]).toMatchObject({
      key: "api_key",
      title: "API Key",
      description: "Your API key",
      sensitive: true,
      required: true,
    });

    // Prompted value landed in the workspace credential store.
    const stored = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(stored).toEqual({ api_key: "sk-prompted" });
  });

  test("overwrites existing stored value when user provides new one", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-old", workDir);
    const gate = mockGate({ responses: { api_key: "sk-new" } });

    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_A,
      workDir,
      gate,
      forcePrompt: true,
    });

    expect(result).toEqual({ api_key: "sk-new" });
    const stored = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(stored).toEqual({ api_key: "sk-new" });
  });

  test("skipped prompt (returns null) → field omitted, not persisted", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-old", workDir);
    const gate = mockGate({ responses: {} }); // returns null for all keys

    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_A,
      workDir,
      gate,
      forcePrompt: true,
    });

    // Field is omitted from the result (user declined to provide).
    expect(result).toEqual({});
    // Existing stored value is preserved — we only persist what the user
    // actively entered.
    const stored = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(stored).toEqual({ api_key: "sk-old" });
  });

  test("forcePrompt without interactive gate → reads store as normal", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-from-store", workDir);

    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_A,
      workDir,
      // no gate provided
      forcePrompt: true,
    });
    expect(result).toEqual({ api_key: "sk-from-store" });
  });

  test("forcePrompt with gate.supportsInteraction=false → reads store as normal", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "sk-from-store", workDir);
    const gate = mockGate({ supportsInteraction: false });

    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_A,
      workDir,
      gate,
      forcePrompt: true,
    });
    expect(result).toEqual({ api_key: "sk-from-store" });
    expect(gate.calls).toHaveLength(0);
  });
});

describe("friendlyMpakConfigError", () => {
  test("translates MpakConfigError into nb config set hints", () => {
    const mpakError = new MpakConfigError("@scope/bundle", [
      { key: "api_key", title: "API Key", sensitive: true },
      { key: "workspace_id", title: "Workspace ID", sensitive: false },
    ]);

    const translated = friendlyMpakConfigError(mpakError, WS_A);
    expect(translated).toBeInstanceOf(Error);
    expect(translated.message).toContain('"API Key"');
    expect(translated.message).toContain('"Workspace ID"');
    expect(translated.message).toContain("@scope/bundle");
    expect(translated.message).toContain(
      `nb config set @scope/bundle api_key=<value> -w ${WS_A}`,
    );
    expect(translated.message).toContain(
      `nb config set @scope/bundle workspace_id=<value> -w ${WS_A}`,
    );
    // References the bundle-declared env-var alternative so users know that
    // path exists too.
    expect(translated.message).toContain("mcp_config.env");
  });

  test("uses field.key when title is empty", () => {
    // MpakConfigError's `title` is required in the type but can be an empty
    // string — make sure we fall through to the raw key in that case.
    const mpakError = new MpakConfigError("@scope/bundle", [
      { key: "raw_key", title: "", sensitive: false },
    ]);
    const translated = friendlyMpakConfigError(mpakError, WS_A);
    expect(translated.message).toContain('"raw_key"');
  });

  test("passes through non-MpakConfigError Error instances unchanged", () => {
    const other = new Error("something else broke");
    const translated = friendlyMpakConfigError(other, WS_A);
    expect(translated).toBe(other);
  });

  test("passes through duck-typed look-alikes (only real MpakConfigError translates)", () => {
    // Before switching to instanceof we accepted any object with the right
    // shape. Now only real SDK errors translate — a look-alike is treated
    // as a plain error and forwarded verbatim.
    const fakeError = Object.assign(new Error("I'm not really one"), {
      code: "CONFIG_MISSING",
      packageName: "@fake/bundle",
      missingFields: [{ key: "x", title: "X", sensitive: false }],
    });
    const translated = friendlyMpakConfigError(fakeError, WS_A);
    expect(translated).toBe(fakeError);
  });

  test("wraps non-Error thrown values", () => {
    const translated = friendlyMpakConfigError("string thrown", WS_A);
    expect(translated).toBeInstanceOf(Error);
    expect(translated.message).toBe("string thrown");
  });

  test("MpakConfigError with empty missingFields falls back to the original message", () => {
    const mpakError = new MpakConfigError("@scope/bundle", []);
    const translated = friendlyMpakConfigError(mpakError, WS_A);
    // The SDK's message format is what the caller sees when there's nothing
    // specific to surface.
    expect(translated.message).toBe(mpakError.message);
  });
});
