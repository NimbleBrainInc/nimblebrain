/**
 * Tests for stale cache fallback in WorkosIdentityProvider.
 *
 * Validates that transient WorkOS API failures don't cause spurious 401s
 * when stale cached data is available:
 * - JWKS fetch failure falls back to stale cached keys
 * - resolveUser API failure falls back to stale cached identity
 * - Fail-closed behavior is preserved when no cache exists
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";

// ── Key generation helpers (shared with workos-authkit.test.ts) ──

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
  return { privateKey: keyPair.privateKey, publicJwk, kid };
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
  return `${headerB64}.${payloadB64}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// ── Test setup ──────────────────────────────────────────────────

let workosKey: TestKeyPair;

const CONFIG: WorkosAuth = {
  adapter: "workos",
  clientId: "client_stale_test",
  redirectUri: "http://localhost/callback",
  organizationId: "org_stale_test",
  apiKey: "sk_test_fake",
};

beforeAll(async () => {
  workosKey = await generateRSAKeyPair("workos-stale-key-1");
});

// ── Provider factory ──────────────────────────────────────────────

function jwksResponseBody() {
  return JSON.stringify({
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
  });
}

function createProvider() {
  const provider = new WorkosIdentityProvider(CONFIG);

  const workos = (provider as unknown as { workos: Record<string, unknown> }).workos;
  workos.userManagement = {
    getUser: async (userId: string) => ({
      id: userId,
      email: `${userId}@test.com`,
      firstName: "Test",
      lastName: "User",
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

  provider.fetcher = async () => new Response(jwksResponseBody(), { status: 200 });

  return provider;
}

function makeRequest(token: string): Request {
  return new Request("http://localhost:27247/v1/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function makeValidToken(sub: string, nowMs: number): Promise<string> {
  const nowSec = Math.floor(nowMs / 1000);
  return createJwt(
    { sub, exp: nowSec + 3600, iat: nowSec, org_id: CONFIG.organizationId },
    workosKey.privateKey,
    workosKey.kid,
  );
}

// ── JWKS stale cache fallback ────────────────────────────────────

describe("JWKS stale cache fallback", () => {
  it("uses stale JWKS when re-fetch returns HTTP error", async () => {
    const provider = createProvider();
    const baseTime = Date.now();
    provider.now = () => baseTime;

    // First request — populates JWKS cache
    const token = await makeValidToken("user_jwks_1", baseTime);
    const first = await provider.verifyRequest(makeRequest(token));
    expect(first).not.toBeNull();

    // Advance past JWKS cache TTL (5 minutes)
    provider.now = () => baseTime + 6 * 60 * 1000;

    // JWKS endpoint returns 500
    provider.fetcher = async () => new Response("Internal Server Error", { status: 500 });

    // Should still verify using stale cached keys
    const token2 = await makeValidToken("user_jwks_1", baseTime + 6 * 60 * 1000);
    const second = await provider.verifyRequest(makeRequest(token2));
    expect(second).not.toBeNull();
    expect(second!.id).toBe("user_jwks_1");
  });

  it("uses stale JWKS when re-fetch throws network error", async () => {
    const provider = createProvider();
    const baseTime = Date.now();
    provider.now = () => baseTime;

    // Populate cache
    const token = await makeValidToken("user_jwks_2", baseTime);
    await provider.verifyRequest(makeRequest(token));

    // Advance past TTL
    provider.now = () => baseTime + 6 * 60 * 1000;

    // Network error
    provider.fetcher = async () => {
      throw new Error("ECONNREFUSED");
    };

    const token2 = await makeValidToken("user_jwks_2", baseTime + 6 * 60 * 1000);
    const result = await provider.verifyRequest(makeRequest(token2));
    expect(result).not.toBeNull();
    expect(result!.id).toBe("user_jwks_2");
  });

  it("rejects when JWKS fetch fails and no cache exists", async () => {
    const provider = createProvider();
    // JWKS endpoint down from the start — no cache to fall back on
    provider.fetcher = async () => new Response("Service Unavailable", { status: 503 });

    const token = await makeValidToken("user_no_cache", Date.now());
    const result = await provider.verifyRequest(makeRequest(token));
    expect(result).toBeNull();
  });
});

// ── resolveUser stale cache fallback ─────────────────────────────

describe("resolveUser stale cache fallback", () => {
  it("uses stale user cache when WorkOS API fails", async () => {
    const provider = createProvider();
    const baseTime = Date.now();
    provider.now = () => baseTime;

    // First request — populates user cache
    const token = await makeValidToken("user_resolve_1", baseTime);
    const first = await provider.verifyRequest(makeRequest(token));
    expect(first).not.toBeNull();
    expect(first!.id).toBe("user_resolve_1");

    // Advance past user cache TTL (5 minutes)
    provider.now = () => baseTime + 6 * 60 * 1000;

    // WorkOS getUser now throws
    const workos = (provider as unknown as { workos: Record<string, unknown> }).workos;
    (workos.userManagement as Record<string, unknown>).getUser = async () => {
      throw new Error("WorkOS API timeout");
    };

    // JWKS cache also expired — provide fresh JWKS so we isolate the resolveUser failure
    provider.fetcher = async () => new Response(jwksResponseBody(), { status: 200 });

    const token2 = await makeValidToken("user_resolve_1", baseTime + 6 * 60 * 1000);
    const second = await provider.verifyRequest(makeRequest(token2));
    expect(second).not.toBeNull();
    expect(second!.id).toBe("user_resolve_1");
    expect(second!.email).toBe("user_resolve_1@test.com");
  });

  it("rejects when WorkOS API fails and no user cache exists", async () => {
    const provider = createProvider();

    // WorkOS getUser throws from the start — no cache to fall back on
    const workos = (provider as unknown as { workos: Record<string, unknown> }).workos;
    (workos.userManagement as Record<string, unknown>).getUser = async () => {
      throw new Error("WorkOS API down");
    };

    const token = await makeValidToken("user_never_seen", Date.now());
    const result = await provider.verifyRequest(makeRequest(token));
    expect(result).toBeNull();
  });

  it("does not fall back to stale cache when user definitively lost org access", async () => {
    const provider = createProvider();
    const baseTime = Date.now();
    provider.now = () => baseTime;

    // Populate cache for a user with org access
    const token = await makeValidToken("user_revoked", baseTime);
    const first = await provider.verifyRequest(makeRequest(token));
    expect(first).not.toBeNull();

    // Advance past cache TTL
    provider.now = () => baseTime + 6 * 60 * 1000;

    // User's org membership was revoked (not an error — empty result)
    const workos = (provider as unknown as { workos: Record<string, unknown> }).workos;
    (workos.userManagement as Record<string, unknown>).listOrganizationMemberships = async () => ({
      data: [], // No memberships — access definitively revoked
    });

    provider.fetcher = async () => new Response(jwksResponseBody(), { status: 200 });

    const token2 = await makeValidToken("user_revoked", baseTime + 6 * 60 * 1000);
    const second = await provider.verifyRequest(makeRequest(token2));
    expect(second).toBeNull();
  });
});
