import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadInstanceConfig, saveInstanceConfig } from "../../../src/identity/instance.ts";
import type { InstanceConfig } from "../../../src/identity/instance.ts";

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-instance-test-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("loadInstanceConfig", () => {
  test("loads valid instance.json with oidc auth", async () => {
    const config: InstanceConfig = {
      auth: {
        adapter: "oidc",
        issuer: "https://auth.example.com",
        clientId: "my-client",
        allowedDomains: ["example.com", "test.com"],
      },
      orgName: "Acme Corp",
    };
    await writeFile(join(workDir, "instance.json"), JSON.stringify(config));

    const result = await loadInstanceConfig(workDir);
    expect(result).toEqual({
      auth: {
        adapter: "oidc",
        issuer: "https://auth.example.com",
        clientId: "my-client",
        allowedDomains: ["example.com", "test.com"],
      },
      orgName: "Acme Corp",
    });
  });

  test("loads valid instance.json with workos auth", async () => {
    const config: InstanceConfig = {
      auth: {
        adapter: "workos",
        clientId: "client_123",
        redirectUri: "http://localhost:3000/v1/auth/callback",
        organizationId: "org_789",
      },
      orgId: "org-789",
      integrations: { slack: { webhookUrl: "https://hooks.slack.com/..." } },
    };
    await writeFile(join(workDir, "instance.json"), JSON.stringify(config));

    const result = await loadInstanceConfig(workDir);
    expect(result).toEqual(config);
  });

  test("returns null when instance.json is missing", async () => {
    const result = await loadInstanceConfig(workDir);
    expect(result).toBeNull();
  });

  test("throws on malformed JSON", async () => {
    await writeFile(join(workDir, "instance.json"), "{ not valid json }");

    await expect(loadInstanceConfig(workDir)).rejects.toThrow("failed to parse JSON");
  });

  test("throws on unknown auth adapter", async () => {
    await writeFile(join(workDir, "instance.json"), JSON.stringify({ auth: { adapter: "saml" } }));

    await expect(loadInstanceConfig(workDir)).rejects.toThrow('unknown auth adapter "saml"');
  });

  test("throws when auth is missing", async () => {
    await writeFile(join(workDir, "instance.json"), JSON.stringify({}));

    await expect(loadInstanceConfig(workDir)).rejects.toThrow("auth must be an object");
  });

  test("throws when oidc auth is missing required fields", async () => {
    await writeFile(
      join(workDir, "instance.json"),
      JSON.stringify({ auth: { adapter: "oidc", issuer: "https://x.com" } }),
    );

    await expect(loadInstanceConfig(workDir)).rejects.toThrow("oidc auth requires string 'clientId'");
  });
});

describe("saveInstanceConfig", () => {
  test("save + load roundtrips correctly", async () => {
    const config: InstanceConfig = {
      auth: {
        adapter: "oidc",
        issuer: "https://auth.example.com",
        clientId: "client-1",
        allowedDomains: ["example.com"],
      },
      orgName: "Test Org",
      orgId: "org-1",
      integrations: { github: { token: "ghp_xxx" } },
    };

    await saveInstanceConfig(workDir, config);
    const loaded = await loadInstanceConfig(workDir);
    expect(loaded).toEqual(config);
  });

  test("writes pretty-printed JSON with trailing newline", async () => {
    const config: InstanceConfig = {
      auth: {
        adapter: "oidc",
        issuer: "https://auth.example.com",
        clientId: "test-client",
        allowedDomains: ["example.com"],
      },
    };
    await saveInstanceConfig(workDir, config);

    const raw = await readFile(join(workDir, "instance.json"), "utf-8");
    expect(raw).toEqual(`${JSON.stringify(config, null, 2)}\n`);
  });

  test("atomic write does not leave temp files on success", async () => {
    const config: InstanceConfig = {
      auth: {
        adapter: "oidc",
        issuer: "https://auth.example.com",
        clientId: "test-client",
        allowedDomains: ["example.com"],
      },
    };
    await saveInstanceConfig(workDir, config);

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(workDir);
    expect(files).toEqual(["instance.json"]);
  });
});
