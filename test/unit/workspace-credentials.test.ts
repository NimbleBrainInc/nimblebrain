import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConfigField, ConfirmationGate } from "../../src/config/privilege.ts";
import {
  bundleSlug,
  clearAllWorkspaceCredentials,
  clearWorkspaceCredential,
  credentialPath,
  envVarName,
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
});

// ── envVarName ────────────────────────────────────────────────────

describe("envVarName", () => {
  test("scoped with trailing `inc`: @nimblebraininc/newsapi + api_key → NB_CONFIG_NIMBLEBRAIN_NEWSAPI_API_KEY", () => {
    expect(envVarName("@nimblebraininc/newsapi", "api_key")).toBe(
      "NB_CONFIG_NIMBLEBRAIN_NEWSAPI_API_KEY",
    );
  });

  test("scoped without `inc`: @foo/bar + field → NB_CONFIG_FOO_BAR_FIELD", () => {
    expect(envVarName("@foo/bar", "field")).toBe("NB_CONFIG_FOO_BAR_FIELD");
  });

  test("unscoped: bundleName + field → NB_CONFIG_BUNDLENAME_FIELD", () => {
    expect(envVarName("bundleName", "field")).toBe("NB_CONFIG_BUNDLENAME_FIELD");
  });

  test("hyphens in name and field become underscores", () => {
    expect(envVarName("my-bundle", "api-key")).toBe("NB_CONFIG_MY_BUNDLE_API_KEY");
    expect(envVarName("@acme/cool-tool", "my-field")).toBe("NB_CONFIG_ACME_COOL_TOOL_MY_FIELD");
  });

  test("edge case: scope of exactly `inc` collapses to empty → falls back to unscoped form", () => {
    expect(envVarName("@inc/foo", "bar")).toBe("NB_CONFIG_FOO_BAR");
  });

  test("edge case: scope `INC` (uppercase) is also stripped case-insensitively", () => {
    expect(envVarName("@INC/foo", "bar")).toBe("NB_CONFIG_FOO_BAR");
  });

  test("scope that contains `inc` but does not end with it is preserved", () => {
    // `incremental` does not end with `inc` — no, wait, it does. Use a real counter-example.
    expect(envVarName("@inco/foo", "bar")).toBe("NB_CONFIG_INCO_FOO_BAR");
  });
});

// ── resolveUserConfig ─────────────────────────────────────────────

/**
 * Minimal in-memory mock of `ConfirmationGate` for testing the interactive
 * branch of `resolveUserConfig`. Tracks calls so assertions can verify the
 * resolver actually prompted (and with what field info).
 */
function mockGate(opts: {
  responses?: Record<string, string | null>;
  supportsInteraction?: boolean;
} = {}): ConfirmationGate & { calls: ConfigField[] } {
  const calls: ConfigField[] = [];
  return {
    supportsInteraction: opts.supportsInteraction ?? true,
    async confirm(): Promise<boolean> {
      return true;
    },
    async promptConfigValue(field: ConfigField): Promise<string | null> {
      calls.push(field);
      const answer = opts.responses?.[field.key];
      return answer === undefined ? null : answer;
    },
    calls,
  };
}

/**
 * Helper to snapshot process.env, mutate it, and restore afterwards.
 * Tests that touch env must always use this to stay hermetic.
 */
function withEnv(keys: string[]) {
  const snapshot: Record<string, string | undefined> = {};
  for (const k of keys) snapshot[k] = process.env[k];
  return {
    set(k: string, v: string): void {
      process.env[k] = v;
    },
    unset(k: string): void {
      delete process.env[k];
    },
    restore(): void {
      for (const k of keys) {
        const v = snapshot[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

describe("resolveUserConfig", () => {
  const SCHEMA: Record<string, UserConfigFieldDef> = {
    api_key: { type: "string", required: true, sensitive: true },
  };

  test("returns {} when schema is null", async () => {
    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: null,
      wsId: WS_A,
      workDir,
    });
    expect(result).toEqual({});
  });

  test("returns {} when schema is undefined", async () => {
    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: undefined,
      wsId: WS_A,
      workDir,
    });
    expect(result).toEqual({});
  });

  test("returns {} when schema is an empty object", async () => {
    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: {},
      wsId: WS_A,
      workDir,
    });
    expect(result).toEqual({});
  });

  // ── Tier priority ──────────────────────────────────────────────

  test("tier 1: workspace credential store beats process env", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.set(envKey, "from-env");
      await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "from-store", workDir);

      const result = await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: SCHEMA,
        wsId: WS_A,
        workDir,
      });
      expect(result).toEqual({ api_key: "from-store" });
    } finally {
      env.restore();
    }
  });

  test("tier 2: process env beats manifest default", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.set(envKey, "from-env");
      const schema: Record<string, UserConfigFieldDef> = {
        api_key: { type: "string", default: "from-default" },
      };

      const result = await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: schema,
        wsId: WS_A,
        workDir,
      });
      expect(result).toEqual({ api_key: "from-env" });
    } finally {
      env.restore();
    }
  });

  test("tier 3: manifest default used when nothing else provides", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.unset(envKey);
      const schema: Record<string, UserConfigFieldDef> = {
        api_key: { type: "string", default: "from-default" },
      };

      const result = await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: schema,
        wsId: WS_A,
        workDir,
      });
      expect(result).toEqual({ api_key: "from-default" });
    } finally {
      env.restore();
    }
  });

  test("manifest default is coerced to string (numbers, booleans)", async () => {
    const envKey1 = envVarName(BUNDLE, "max_items");
    const envKey2 = envVarName(BUNDLE, "enabled");
    const env = withEnv([envKey1, envKey2]);
    try {
      env.unset(envKey1);
      env.unset(envKey2);
      const schema: Record<string, UserConfigFieldDef> = {
        max_items: { type: "number", default: 42 },
        enabled: { type: "boolean", default: true },
      };

      const result = await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: schema,
        wsId: WS_A,
        workDir,
      });
      expect(result).toEqual({ max_items: "42", enabled: "true" });
    } finally {
      env.restore();
    }
  });

  test("mixed: field A from workspace, B from env, C from default", async () => {
    const envKeyB = envVarName(BUNDLE, "field_b");
    const envKeyA = envVarName(BUNDLE, "field_a");
    const envKeyC = envVarName(BUNDLE, "field_c");
    const env = withEnv([envKeyA, envKeyB, envKeyC]);
    try {
      env.unset(envKeyA);
      env.set(envKeyB, "from-env-b");
      env.unset(envKeyC);

      await saveWorkspaceCredential(WS_A, BUNDLE, "field_a", "from-store-a", workDir);

      const schema: Record<string, UserConfigFieldDef> = {
        field_a: { type: "string" },
        field_b: { type: "string" },
        field_c: { type: "string", default: "from-default-c" },
      };

      const result = await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: schema,
        wsId: WS_A,
        workDir,
      });
      expect(result).toEqual({
        field_a: "from-store-a",
        field_b: "from-env-b",
        field_c: "from-default-c",
      });
    } finally {
      env.restore();
    }
  });

  test("workspace isolation: two workspaces resolve different values for same bundle", async () => {
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

  // ── Required / optional ────────────────────────────────────────

  test("missing required field (no gate) throws with -w <wsId> hint", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.unset(envKey);

      await expect(
        resolveUserConfig({
          bundleName: BUNDLE,
          userConfigSchema: SCHEMA,
          wsId: WS_A,
          workDir,
        }),
      ).rejects.toThrow(/nb config set .*-w ws_alpha/);
    } finally {
      env.restore();
    }
  });

  test("error message includes bundle name and field key, but not stored values", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.unset(envKey);

      let thrown: Error | undefined;
      try {
        await resolveUserConfig({
          bundleName: BUNDLE,
          userConfigSchema: SCHEMA,
          wsId: WS_A,
          workDir,
        });
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown?.message).toContain(BUNDLE);
      expect(thrown?.message).toContain("api_key");
      // no value should be in the message (the stored value, if any, is sk-)
      expect(thrown?.message).not.toContain("sk-");
    } finally {
      env.restore();
    }
  });

  test("missing required with non-interactive gate throws with -w <wsId> hint", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.unset(envKey);
      const gate = mockGate({ supportsInteraction: false });

      await expect(
        resolveUserConfig({
          bundleName: BUNDLE,
          userConfigSchema: SCHEMA,
          wsId: WS_A,
          workDir,
          gate,
        }),
      ).rejects.toThrow(/-w ws_alpha/);
      expect(gate.calls).toHaveLength(0);
    } finally {
      env.restore();
    }
  });

  test("error message prefers field.title over field key when available", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.unset(envKey);
      const schema: Record<string, UserConfigFieldDef> = {
        api_key: { type: "string", required: true, title: "API Key" },
      };

      await expect(
        resolveUserConfig({
          bundleName: BUNDLE,
          userConfigSchema: schema,
          wsId: WS_A,
          workDir,
        }),
      ).rejects.toThrow(/"API Key"/);
    } finally {
      env.restore();
    }
  });

  test("missing optional field (required: false) is silently omitted", async () => {
    const envKey = envVarName(BUNDLE, "opt_field");
    const env = withEnv([envKey]);
    try {
      env.unset(envKey);
      const schema: Record<string, UserConfigFieldDef> = {
        opt_field: { type: "string", required: false },
      };

      const result = await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: schema,
        wsId: WS_A,
        workDir,
      });
      expect(result).toEqual({});
    } finally {
      env.restore();
    }
  });

  test("field without explicit `required` defaults to required (throws when missing)", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.unset(envKey);
      const schema: Record<string, UserConfigFieldDef> = {
        api_key: { type: "string" }, // no `required` field
      };

      await expect(
        resolveUserConfig({
          bundleName: BUNDLE,
          userConfigSchema: schema,
          wsId: WS_A,
          workDir,
        }),
      ).rejects.toThrow(/Missing required/);
    } finally {
      env.restore();
    }
  });

  // ── Interactive prompting ──────────────────────────────────────

  test("interactive gate: prompts for missing field, saves result to workspace store", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.unset(envKey);

      const gate = mockGate({ responses: { api_key: "prompted-value" } });

      const result = await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: SCHEMA,
        wsId: WS_A,
        workDir,
        gate,
      });
      expect(result).toEqual({ api_key: "prompted-value" });
      expect(gate.calls).toHaveLength(1);
      expect(gate.calls[0]).toMatchObject({ key: "api_key", sensitive: true, required: true });

      // Value should now be on disk.
      const stored = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
      expect(stored).toEqual({ api_key: "prompted-value" });
    } finally {
      env.restore();
    }
  });

  test("interactive gate: prompt returning null on required field throws", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.unset(envKey);
      const gate = mockGate({ responses: { api_key: null } });

      await expect(
        resolveUserConfig({
          bundleName: BUNDLE,
          userConfigSchema: SCHEMA,
          wsId: WS_A,
          workDir,
          gate,
        }),
      ).rejects.toThrow(/Missing required/);
      expect(gate.calls).toHaveLength(1);
    } finally {
      env.restore();
    }
  });

  test("interactive gate: prompt returning null on optional field silently omits it", async () => {
    const schema: Record<string, UserConfigFieldDef> = {
      opt_field: { type: "string", required: false },
    };
    const envKey = envVarName(BUNDLE, "opt_field");
    const env = withEnv([envKey]);
    try {
      env.unset(envKey);
      const gate = mockGate({ responses: { opt_field: null } });

      const result = await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: schema,
        wsId: WS_A,
        workDir,
        gate,
      });
      expect(result).toEqual({});
    } finally {
      env.restore();
    }
  });

  test("forcePrompt: re-prompts even when a stored value already exists", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "stored-old", workDir);
    const gate = mockGate({ responses: { api_key: "prompted-new" } });

    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_A,
      workDir,
      gate,
      forcePrompt: true,
    });
    expect(result).toEqual({ api_key: "prompted-new" });
    expect(gate.calls).toHaveLength(1);

    // Stored value should be overwritten.
    const stored = await getWorkspaceCredentials(WS_A, BUNDLE, workDir);
    expect(stored).toEqual({ api_key: "prompted-new" });
  });

  test("forcePrompt without an interactive gate is a no-op (uses stored value)", async () => {
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "stored", workDir);

    const result = await resolveUserConfig({
      bundleName: BUNDLE,
      userConfigSchema: SCHEMA,
      wsId: WS_A,
      workDir,
      forcePrompt: true,
      // no gate
    });
    expect(result).toEqual({ api_key: "stored" });
  });

  test("interactive gate passes title/description/sensitive to promptConfigValue", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.unset(envKey);
      const schema: Record<string, UserConfigFieldDef> = {
        api_key: {
          type: "string",
          title: "API Key",
          description: "Your NewsAPI key",
          sensitive: true,
          required: true,
        },
      };
      const gate = mockGate({ responses: { api_key: "prompted" } });

      await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: schema,
        wsId: WS_A,
        workDir,
        gate,
      });
      expect(gate.calls[0]).toEqual({
        key: "api_key",
        title: "API Key",
        description: "Your NewsAPI key",
        sensitive: true,
        required: true,
      });
    } finally {
      env.restore();
    }
  });

  // ── Empty-string semantics ─────────────────────────────────────
  //
  // Empty strings in the workspace store or process env are treated as
  // "absent" and fall through to the next tier. Almost always reflects
  // an accidentally-cleared credential, so falling through is friendlier
  // than propagating `""` as a real value. Note this is intentionally
  // opposite to how the mpak SDK's userConfig override treats empties
  // (where `""` is a deliberate choice by the caller). Keep these tests
  // locked in — a future refactor shouldn't quietly flip the semantics.

  test("empty string in workspace store falls through to process env", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.set(envKey, "from-env");
      await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "", workDir);

      const result = await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: SCHEMA,
        wsId: WS_A,
        workDir,
      });
      expect(result).toEqual({ api_key: "from-env" });
    } finally {
      env.restore();
    }
  });

  test("empty string in process env falls through to manifest default", async () => {
    const envKey = envVarName(BUNDLE, "api_key");
    const env = withEnv([envKey]);
    try {
      env.set(envKey, "");
      const schema: Record<string, UserConfigFieldDef> = {
        api_key: { type: "string", default: "from-default", required: true },
      };

      const result = await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: schema,
        wsId: WS_A,
        workDir,
      });
      expect(result).toEqual({ api_key: "from-default" });
    } finally {
      env.restore();
    }
  });

  // ── forcePrompt + null response ────────────────────────────────

  test("forcePrompt + gate returns null for required field throws actionable error", async () => {
    // forcePrompt skips tiers 1-3 even if values exist; if the gate then
    // refuses to provide a value for a required field, we should still
    // throw the same "Missing required" error as the non-interactive path.
    await saveWorkspaceCredential(WS_A, BUNDLE, "api_key", "stored", workDir);
    const gate = mockGate({ responses: {} }); // returns null for unknown keys

    let thrown: Error | undefined;
    try {
      await resolveUserConfig({
        bundleName: BUNDLE,
        userConfigSchema: SCHEMA,
        wsId: WS_A,
        workDir,
        gate,
        forcePrompt: true,
      });
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.message).toMatch(/api_key|API key/i);
    expect(thrown?.message).toMatch(/nb config set/);
    expect(thrown?.message).toContain(WS_A);
    // Stored value must not leak into the error message.
    expect(thrown?.message).not.toContain("stored");
    expect(gate.calls).toHaveLength(1);
  });
});
