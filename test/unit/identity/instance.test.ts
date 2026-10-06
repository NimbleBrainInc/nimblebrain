import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceConfig } from "../../../src/identity/instance.ts";
import { loadInstanceConfig, saveInstanceConfig } from "../../../src/identity/instance.ts";

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
        organizationId: "org_789",
      },
      orgId: "org-789",
      integrations: { slack: { webhookUrl: "https://hooks.slack.com/..." } },
    };
    await writeFile(join(workDir, "instance.json"), JSON.stringify(config));

    const result = await loadInstanceConfig(workDir);
    expect(result).toEqual(config);
  });

  test("ignores a redirectUri in instance.json (the provider derives it)", async () => {
    await writeFile(
      join(workDir, "instance.json"),
      JSON.stringify({
        auth: {
          adapter: "workos",
          clientId: "client_123",
          redirectUri: "https://other.example.com/v1/auth/callback",
          organizationId: "org_789",
        },
      }),
    );

    const result = await loadInstanceConfig(workDir);
    expect(result?.auth).toEqual({
      adapter: "workos",
      clientId: "client_123",
      organizationId: "org_789",
    });
  });

  test("rejects workos auth with an empty or whitespace organizationId", async () => {
    for (const organizationId of ["", "   "]) {
      await writeFile(
        join(workDir, "instance.json"),
        JSON.stringify({ auth: { adapter: "workos", clientId: "client_123", organizationId } }),
      );
      await expect(loadInstanceConfig(workDir)).rejects.toThrow(
        "workos auth 'organizationId' must not be empty",
      );
    }
  });

  test("loads workos auth with organizationId omitted (no organization scope)", async () => {
    await writeFile(
      join(workDir, "instance.json"),
      JSON.stringify({ auth: { adapter: "workos", clientId: "client_123" } }),
    );
    const result = await loadInstanceConfig(workDir);
    expect(result?.auth).toEqual({ adapter: "workos", clientId: "client_123" });
  });

  test("loads workos auth with custom adminRoleSlugs", async () => {
    const config: InstanceConfig = {
      auth: {
        adapter: "workos",
        clientId: "client_123",
        organizationId: "org_789",
        adminRoleSlugs: ["org-admin", "owner"],
      },
    };
    await writeFile(join(workDir, "instance.json"), JSON.stringify(config));

    const result = await loadInstanceConfig(workDir);
    expect(result).toEqual(config);
  });

  test("rejects an empty adminRoleSlugs (would lock out every admin)", async () => {
    await writeFile(
      join(workDir, "instance.json"),
      JSON.stringify({
        auth: {
          adapter: "workos",
          clientId: "client_123",
          adminRoleSlugs: [],
        },
      }),
    );
    await expect(loadInstanceConfig(workDir)).rejects.toThrow(
      "'adminRoleSlugs' must contain at least one",
    );
  });

  test("loads workos auth with firstPartyClientIds, an empty list included", async () => {
    for (const firstPartyClientIds of [["client_test_channels"], []]) {
      const config: InstanceConfig = {
        auth: { adapter: "workos", clientId: "client_123", firstPartyClientIds },
      };
      await writeFile(join(workDir, "instance.json"), JSON.stringify(config));
      expect(await loadInstanceConfig(workDir)).toEqual(config);
    }
  });

  test("rejects a firstPartyClientIds that is not an array of strings", async () => {
    for (const firstPartyClientIds of ["client_test_channels", [7]]) {
      await writeFile(
        join(workDir, "instance.json"),
        JSON.stringify({
          auth: { adapter: "workos", clientId: "client_123", firstPartyClientIds },
        }),
      );
      await expect(loadInstanceConfig(workDir)).rejects.toThrow(
        "'firstPartyClientIds' must be an array of strings",
      );
    }
  });

  test("returns null when instance.json is missing", async () => {
    const result = await loadInstanceConfig(workDir);
    expect(result).toBeNull();
  });

  test("loads the dev adapter", async () => {
    await writeFile(join(workDir, "instance.json"), JSON.stringify({ auth: { adapter: "dev" } }));

    const config = await loadInstanceConfig(workDir);
    expect(config).toEqual({ auth: { adapter: "dev" } });
  });

  test("throws on a non-string auth adapter", async () => {
    await writeFile(join(workDir, "instance.json"), JSON.stringify({ auth: { adapter: 42 } }));

    await expect(loadInstanceConfig(workDir)).rejects.toThrow('unknown auth adapter "42"');
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

    await expect(loadInstanceConfig(workDir)).rejects.toThrow(
      "oidc auth requires string 'clientId'",
    );
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
