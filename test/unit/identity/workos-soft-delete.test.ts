/**
 * Tests the soft-delete access gate in WorkosIdentityProvider.
 *
 * A deactivated (soft-deleted) user keeps a valid WorkOS identity and org
 * membership, but verifyRequest must deny them until an admin restores the
 * account. Restoring re-enables access. This is the access-control half of
 * the soft-delete flow (the data half lives in UserStore tests).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "bun:test";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";
import { UserStore } from "../../../src/identity/user.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

// ── Crypto helpers ──────────────────────────────────────────────────

interface TestKeyPair {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  kid: string;
}

async function generateRSAKeyPair(kid: string): Promise<TestKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicJwk.kid = kid;
  publicJwk.use = "sig";
  return { privateKey: keyPair.privateKey, publicJwk, kid };
}

function base64UrlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createJwt(payload: Record<string, unknown>, privateKey: CryptoKey, kid: string): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid };
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// ── Setup ───────────────────────────────────────────────────────────

let workosKey: TestKeyPair;

const CONFIG: WorkosAuth = {
  adapter: "workos",
  clientId: "client_soft_delete_test",
  redirectUri: "http://localhost/callback",
  organizationId: "org_soft_delete_test",
  apiKey: "sk_test_fake",
};

beforeAll(async () => {
  workosKey = await generateRSAKeyPair("workos-soft-delete-key-1");
});

function jwksResponseBody(): string {
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

function createProvider(): { provider: WorkosIdentityProvider; userStore: UserStore } {
  const dir = mkdtempSync(join(tmpdir(), "workos-soft-delete-"));
  const userStore = new UserStore(dir);
  const workspaceStore = new WorkspaceStore(dir);
  const provider = new WorkosIdentityProvider(CONFIG, userStore, workspaceStore);

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
      data: [{ id: "om_test", userId: opts.userId, organizationId: opts.organizationId, role: { slug: "member" }, status: "active" }],
    }),
  };
  provider.fetcher = async () => new Response(jwksResponseBody(), { status: 200 });

  return { provider, userStore };
}

function makeRequest(token: string): Request {
  return new Request("http://localhost:27247/v1/chat", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function makeValidToken(sub: string): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return createJwt({ sub, exp: nowSec + 3600, iat: nowSec, org_id: CONFIG.organizationId }, workosKey.privateKey, workosKey.kid);
}

// ── Tests ───────────────────────────────────────────────────────────

describe("WorkOS soft-delete access gate", () => {
  it("admits an active user, then denies them once soft-deleted", async () => {
    const { provider, userStore } = createProvider();
    const sub = "user_softdel_1";

    // First login provisions the local profile and succeeds.
    const ok = await provider.verifyRequest(makeRequest(await makeValidToken(sub)));
    expect(ok).not.toBeNull();
    expect(ok!.id).toBe(sub);

    // Deactivate, then drop the identity cache (as the tool does).
    await userStore.softDelete(sub);
    provider.invalidateUser(sub);

    // Same valid token, same live WorkOS membership — but now denied.
    const denied = await provider.verifyRequest(makeRequest(await makeValidToken(sub)));
    expect(denied).toBeNull();
  });

  it("re-admits the user after restore", async () => {
    const { provider, userStore } = createProvider();
    const sub = "user_softdel_2";

    await provider.verifyRequest(makeRequest(await makeValidToken(sub)));
    await userStore.softDelete(sub);
    provider.invalidateUser(sub);
    expect(await provider.verifyRequest(makeRequest(await makeValidToken(sub)))).toBeNull();

    await userStore.restore(sub);
    provider.invalidateUser(sub);
    const restored = await provider.verifyRequest(makeRequest(await makeValidToken(sub)));
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(sub);
  });
});
