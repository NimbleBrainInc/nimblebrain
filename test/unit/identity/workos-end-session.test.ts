/**
 * WorkOS sign-out ends the WorkOS session, not only this instance's cookies.
 *
 * AuthKit keeps its own session. Left open, the next sign-in resumes it without
 * asking for credentials, so signing out neither protects a shared machine nor
 * lets someone switch accounts. `endSession` revokes the session the token's
 * `sid` names: from an expired token too, since sign-out often follows one, but
 * never from a token whose signature does not verify.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import type { webcrypto } from "node:crypto";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";
import { fakeFetch } from "../../helpers/fake-fetch.ts";

// ── Key generation helpers (mirror workos-org-scope.test.ts) ────────

interface TestKeyPair {
  privateKey: CryptoKey;
  publicJwk: webcrypto.JsonWebKey & { kid?: string };
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
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid };
  return { privateKey: keyPair.privateKey, publicJwk, kid };
}

function base64UrlEncode(data: Uint8Array): string {
  const binary = String.fromCharCode(...data);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createJwt(payload: Record<string, unknown>, key: TestKeyPair): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: key.kid };
  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// ── Setup ───────────────────────────────────────────────────────────

const CONFIG: WorkosAuth = {
  adapter: "workos",
  clientId: "client_test_signout",
  organizationId: "org_signout",
  apiKey: "sk_test_fake_signout",
};

let workosKey: TestKeyPair;
let foreignKey: TestKeyPair;

beforeAll(async () => {
  workosKey = await generateRSAKeyPair("workos-key-1");
  // Same kid, different key: a token signed by anyone but WorkOS.
  foreignKey = await generateRSAKeyPair("workos-key-1");
});

/** A provider whose JWKS is `workosKey` and whose revocations are recorded. */
function createProvider(): { provider: WorkosIdentityProvider; revoked: string[] } {
  const provider = new WorkosIdentityProvider(CONFIG, undefined);
  const revoked: string[] = [];
  const workos = (provider as unknown as { workos: Record<string, unknown> }).workos;
  workos.userManagement = {
    revokeSession: async ({ sessionId }: { sessionId: string }) => {
      revoked.push(sessionId);
    },
  };
  provider.fetcher = fakeFetch(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== `https://api.workos.com/sso/jwks/${CONFIG.clientId}`) {
      return new Response("Not Found", { status: 404 });
    }
    const { kty, kid, n, e } = workosKey.publicJwk;
    return new Response(JSON.stringify({ keys: [{ kty, kid, n, e, alg: "RS256", use: "sig" }] }));
  });
  return { provider, revoked };
}

async function sessionToken(
  claims: Record<string, unknown>,
  key: TestKeyPair = workosKey,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  return createJwt(
    {
      sub: "user_signout",
      org_id: CONFIG.organizationId,
      iat: nowSec,
      exp: nowSec + 300,
      ...claims,
    },
    key,
  );
}

function logoutRequest(token: string): Request {
  return new Request("http://localhost:27247/v1/auth/logout", {
    method: "POST",
    headers: { cookie: `nb_session=${token}; nb_refresh=rt_live` },
  });
}

// ── endSession ──────────────────────────────────────────────────────

describe("WorkosIdentityProvider.endSession", () => {
  it("revokes the session the token names", async () => {
    const { provider, revoked } = createProvider();
    await provider.endSession(logoutRequest(await sessionToken({ sid: "session_abc" })));
    expect(revoked).toEqual(["session_abc"]);
  });

  it("revokes the session behind an expired token", async () => {
    const { provider, revoked } = createProvider();
    const pastSec = Math.floor(Date.now() / 1000) - 7200;
    const token = await sessionToken({ sid: "session_lapsed", iat: pastSec, exp: pastSec + 300 });
    await provider.endSession(logoutRequest(token));
    expect(revoked).toEqual(["session_lapsed"]);
  });

  it("does not revoke a session a forged token names", async () => {
    const { provider, revoked } = createProvider();
    const forged = await sessionToken({ sid: "session_victim" }, foreignKey);
    await provider.endSession(logoutRequest(forged));
    expect(revoked).toEqual([]);
  });

  it("revokes nothing when the request carries no session", async () => {
    const { provider, revoked } = createProvider();
    await provider.endSession(
      new Request("http://localhost:27247/v1/auth/logout", { method: "POST" }),
    );
    await provider.endSession(logoutRequest(await sessionToken({})));
    await provider.endSession(logoutRequest("not-a-jwt"));
    expect(revoked).toEqual([]);
  });
});
