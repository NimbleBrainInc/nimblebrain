/**
 * Tests for AuthKit JWKS verification in WorkosIdentityProvider.
 *
 * Validates:
 * - JWT verification against AuthKit JWKS when issuer matches authkitDomain
 * - Rejection of expired tokens
 * - Rejection of tokens with wrong issuer
 * - Fallback to WorkOS JWKS path when authkitDomain is not configured
 * - getAuthkitDomain() behavior
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll } from "bun:test";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

// ── Key generation helpers ──────────────────────────────────────

interface TestKeyPair {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  kid: string;
}

async function generateRSAKeyPair(kid: string): Promise<TestKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = kid;
  publicJwk.use = "sig";

  return {
    privateKey: keyPair.privateKey,
    publicJwk,
    kid,
  };
}

function base64UrlEncode(data: Uint8Array): string {
  const binary = String.fromCharCode(...data);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createJwt(
  payload: Record<string, unknown>,
  privateKey: CryptoKey,
  kid: string,
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid };
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  const signatureB64 = base64UrlEncode(new Uint8Array(signature));
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

// ── Test setup ──────────────────────────────────────────────────

let authkitKey: TestKeyPair;
let workosKey: TestKeyPair;

const BASE_CONFIG: WorkosAuth = {
  adapter: "workos",
  clientId: "client_test_authkit",
  redirectUri: "http://localhost/callback",
  organizationId: "org_test_authkit",
  apiKey: "sk_test_fake_authkit",
  authkitDomain: "testapp",
};

beforeAll(async () => {
  authkitKey = await generateRSAKeyPair("authkit-key-1");
  workosKey = await generateRSAKeyPair("workos-key-1");
});

// ── Provider factory ─────────────────────────────────────────────

function createProvider(configOverrides?: Partial<WorkosAuth>): {
  provider: WorkosIdentityProvider;
  workspaceStore: WorkspaceStore;
} {
  const config = { ...BASE_CONFIG, ...configOverrides };
  const workspaceStore = new WorkspaceStore(mkdtempSync(join(tmpdir(), "workos-authkit-")));
  const provider = new WorkosIdentityProvider(config, undefined, workspaceStore);

  // Mock the WorkOS SDK to handle resolveUser internals
  const workos = (provider as unknown as { workos: Record<string, unknown> }).workos;
  workos.userManagement = {
    getUser: async (userId: string) => ({
      id: userId,
      email: `${userId}@test.com`,
      firstName: "Test",
      lastName: "AuthKit",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    listOrganizationMemberships: async (opts: { userId: string; organizationId: string }) => ({
      data: [
        {
          id: "om_test",
          userId: opts.userId,
          organizationId: opts.organizationId,
          role: { slug: "member" },
          status: "active",
        },
      ],
    }),
    getAuthorizationUrl: () => "https://fake.workos.com/authorize",
    listUsers: async () => ({ data: [] }),
    createUser: async () => ({}),
    deleteUser: async () => {},
  };

  // Mock fetcher to serve JWKS endpoints
  provider.fetcher = async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    if (url === "https://testapp.authkit.app/oauth2/jwks") {
      return new Response(
        JSON.stringify({
          keys: [
            {
              kty: authkitKey.publicJwk.kty,
              kid: authkitKey.publicJwk.kid,
              n: authkitKey.publicJwk.n,
              e: authkitKey.publicJwk.e,
              alg: "RS256",
              use: "sig",
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (url === `https://api.workos.com/sso/jwks/${config.clientId}`) {
      return new Response(
        JSON.stringify({
          keys: [
            {
              kty: workosKey.publicJwk.kty,
              kid: workosKey.publicJwk.kid,
              n: workosKey.publicJwk.n,
              e: workosKey.publicJwk.e,
              alg: "RS256",
              use: "sig",
            },
          ],
        }),
        { status: 200 },
      );
    }

    return new Response("Not Found", { status: 404 });
  };

  return { provider, workspaceStore };
}

function makeRequest(token: string): Request {
  return new Request("http://localhost:27247/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

// ── getAuthkitDomain ─────────────────────────────────────────────

describe("getAuthkitDomain", () => {
  it("returns configured domain", () => {
    const { provider } = createProvider();
    expect(provider.getAuthkitDomain()).toBe("testapp");
  });

  it("returns undefined when not configured", () => {
    const { provider } = createProvider({ authkitDomain: undefined });
    expect(provider.getAuthkitDomain()).toBeUndefined();
  });
});

// ── AuthKit JWT verification ─────────────────────────────────────

describe("verifyRequest with AuthKit JWT", () => {
  it("verifies valid AuthKit JWT with correct issuer", async () => {
    const { provider } = createProvider();
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await createJwt(
      {
        sub: "user_authkit_1",
        iss: "https://testapp.authkit.app",
        exp: nowSec + 3600,
        iat: nowSec,
      },
      authkitKey.privateKey,
      authkitKey.kid,
    );

    const identity = await provider.verifyRequest(makeRequest(token));
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user_authkit_1");
    expect(identity!.email).toBe("user_authkit_1@test.com");
  });

  it("provisions a workspace on successful AuthKit auth (MCP OAuth path)", async () => {
    // AuthKit tokens never route through exchangeCode (that's the browser
    // auth-code flow). verifyRequest is the only place the invariant
    // "authenticated user has ≥1 workspace" can be established for this
    // path — so workspace provisioning must live there.
    const { provider, workspaceStore } = createProvider();
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await createJwt(
      {
        sub: "user_authkit_mcp",
        iss: "https://testapp.authkit.app",
        exp: nowSec + 3600,
        iat: nowSec,
      },
      authkitKey.privateKey,
      authkitKey.kid,
    );

    const identity = await provider.verifyRequest(makeRequest(token));
    expect(identity).not.toBeNull();

    const workspaces = await workspaceStore.getWorkspacesForUser(identity!.id);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.members).toEqual([
      { userId: identity!.id, role: "admin" },
    ]);
  });

  it("rejects expired AuthKit JWT", async () => {
    const { provider } = createProvider();
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await createJwt(
      {
        sub: "user_authkit_expired",
        iss: "https://testapp.authkit.app",
        exp: nowSec - 100, // expired 100 seconds ago
        iat: nowSec - 3700,
      },
      authkitKey.privateKey,
      authkitKey.kid,
    );

    const identity = await provider.verifyRequest(makeRequest(token));
    expect(identity).toBeNull();
  });

  it("rejects JWT with wrong issuer (not matching authkitDomain)", async () => {
    const { provider } = createProvider();
    const nowSec = Math.floor(Date.now() / 1000);

    // Sign with authkit key but use wrong issuer — should not match AuthKit path
    // and will fall through to WorkOS path where it won't verify against workos JWKS
    // (since it was signed with the authkit key, not the workos key)
    const token = await createJwt(
      {
        sub: "user_wrong_issuer",
        iss: "https://evil.example.com",
        exp: nowSec + 3600,
        iat: nowSec,
      },
      authkitKey.privateKey,
      authkitKey.kid,
    );

    const identity = await provider.verifyRequest(makeRequest(token));
    expect(identity).toBeNull();
  });

  it("falls through to WorkOS path when no authkitDomain is configured", async () => {
    const { provider } = createProvider({ authkitDomain: undefined });
    const nowSec = Math.floor(Date.now() / 1000);

    // Use a token signed with workos key with a WorkOS-style issuer (no iss check in WorkOS path)
    const token = await createJwt(
      {
        sub: "user_workos_fallback",
        iss: "https://api.workos.com",
        exp: nowSec + 3600,
        iat: nowSec,
        org_id: "org_test_authkit",
      },
      workosKey.privateKey,
      workosKey.kid,
    );

    const identity = await provider.verifyRequest(makeRequest(token));
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user_workos_fallback");
  });

  it("rejects JWT signed with wrong key against AuthKit JWKS", async () => {
    const { provider } = createProvider();
    const nowSec = Math.floor(Date.now() / 1000);

    // Sign with workos key but claim AuthKit issuer
    const token = await createJwt(
      {
        sub: "user_bad_sig",
        iss: "https://testapp.authkit.app",
        exp: nowSec + 3600,
        iat: nowSec,
      },
      workosKey.privateKey,
      workosKey.kid,
    );

    const identity = await provider.verifyRequest(makeRequest(token));
    expect(identity).toBeNull();
  });

  it("uses now() override for expiration check", async () => {
    const { provider } = createProvider();

    // Set time to the future so the token appears expired
    const realNow = Date.now();
    const futureMs = realNow + 10 * 3600 * 1000; // 10 hours from now
    provider.now = () => futureMs;

    const nowSec = Math.floor(realNow / 1000);
    const token = await createJwt(
      {
        sub: "user_time_test",
        iss: "https://testapp.authkit.app",
        exp: nowSec + 3600, // expires 1 hour from real now, but provider thinks it's 10 hours later
        iat: nowSec,
      },
      authkitKey.privateKey,
      authkitKey.kid,
    );

    const identity = await provider.verifyRequest(makeRequest(token));
    expect(identity).toBeNull();
  });
});
