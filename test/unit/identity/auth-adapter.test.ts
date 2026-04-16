import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIdentityProvider } from "../../../src/identity/provider.ts";
import type { UserIdentity } from "../../../src/identity/provider.ts";
import { OidcIdentityProvider } from "../../../src/identity/providers/oidc.ts";
import type { InstanceConfig } from "../../../src/identity/instance.ts";
import type { User } from "../../../src/identity/user.ts";
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
  test("returns null when config is null (dev mode)", () => {
    const result = createIdentityProvider(null, userStore);
    expect(result).toBeNull();
  });

  test("throws descriptive error for unknown adapter type", () => {
    const config = { auth: { adapter: "foobar" } } as unknown as InstanceConfig;
    expect(() => createIdentityProvider(config, userStore)).toThrow('Unknown identity provider: "foobar"');
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
    const adapter = createIdentityProvider(config, userStore);
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
    const provider = createIdentityProvider(config, userStore);
    expect(provider).not.toBeNull();
    expect(provider!.capabilities.authCodeFlow).toBe(true);
    expect(provider!.capabilities.managedUsers).toBe(true);
  });

  test("throws for unknown adapter type", () => {
    const config = {
      auth: { adapter: "nosuch" },
    } as unknown as InstanceConfig;
    expect(() => createIdentityProvider(config, userStore)).toThrow('Unknown identity provider: "nosuch"');
  });
});

describe("UserIdentity", () => {
  test("is a strict subset of User (no extra fields leak)", () => {
    const user: User = {
      id: "usr_abc123",
      email: "test@example.com",
      displayName: "Test User",
      orgRole: "member",
      preferences: { timezone: "UTC" },
      identity: "some-identity",
      integrationEntityId: "ext-123",
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T00:00:00.000Z",
    };

    // Extract only UserIdentity fields from a User
    const identity: UserIdentity = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      orgRole: user.orgRole,
    };

    // UserIdentity should only have these 4 keys
    expect(Object.keys(identity)).toEqual(["id", "email", "displayName", "orgRole"]);

    // Verify none of the User-only fields are present
    expect("preferences" in identity).toBe(false);
    expect("createdAt" in identity).toBe(false);
    expect("updatedAt" in identity).toBe(false);
    expect("identity" in identity).toBe(false);
    expect("integrationEntityId" in identity).toBe(false);
  });
});
