import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstanceConfig } from "../../../src/identity/instance.ts";
import { createIdentityProvider } from "../../../src/identity/provider.ts";
import { DevIdentityProvider } from "../../../src/identity/providers/dev.ts";
import { OidcIdentityProvider } from "../../../src/identity/providers/oidc.ts";
import { UserStore } from "../../../src/identity/user.ts";

let workDir: string;
let userStore: UserStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-auth-adapter-test-"));
  userStore = new UserStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("createIdentityProvider", () => {
  test("creates DevIdentityProvider for dev config", () => {
    const config: InstanceConfig = { auth: { adapter: "dev" } };
    const provider = createIdentityProvider(config, userStore, workDir);
    expect(provider).toBeInstanceOf(DevIdentityProvider);
  });

  test("throws descriptive error for unknown adapter type", () => {
    const config = { auth: { adapter: "foobar" } } as unknown as InstanceConfig;
    expect(() => createIdentityProvider(config, userStore, workDir)).toThrow(
      'Unknown identity provider: "foobar"',
    );
  });

  test("creates OidcIdentityProvider for oidc config", () => {
    const config: InstanceConfig = {
      auth: {
        adapter: "oidc",
        issuer: "https://auth.example.com",
        clientId: "cid",
        allowedDomains: ["example.com"],
      },
    };
    const adapter = createIdentityProvider(config, userStore, workDir);
    expect(adapter).not.toBeNull();
    expect(adapter).toBeInstanceOf(OidcIdentityProvider);
  });

  test("creates WorkosIdentityProvider for workos config", () => {
    const config: InstanceConfig = {
      auth: {
        adapter: "workos",
        clientId: "client_123",
        redirectUri: "http://localhost:3000/v1/auth/callback",
      },
    };
    const provider = createIdentityProvider(config, userStore, workDir);
    expect(provider).not.toBeNull();
    expect(provider!.capabilities.authCodeFlow).toBe(true);
    expect(provider!.capabilities.managedUsers).toBe(true);
  });

  test("throws for unknown adapter type", () => {
    const config = {
      auth: { adapter: "nosuch" },
    } as unknown as InstanceConfig;
    expect(() => createIdentityProvider(config, userStore, workDir)).toThrow(
      'Unknown identity provider: "nosuch"',
    );
  });
});
