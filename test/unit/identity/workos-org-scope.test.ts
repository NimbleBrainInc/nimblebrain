/**
 * Regression tests for the involuntary-logout incident (Sentry `retry_401`).
 *
 * Root cause: `refreshToken()` minted the new access token WITHOUT pinning the
 * configured organization, so for a multi-org user WorkOS could return a token
 * scoped to a different org. That token then failed `verifyRequest`'s `org_id`
 * gate on the very next request — a refresh that "succeeds" yet yields a token
 * the session rejects, surfacing to the user as an involuntary logout.
 *
 * These tests pin both halves:
 *  1. refreshToken pins organizationId (the fix), and omits it when unconfigured.
 *  2. verifyRequest rejects an org-mismatched token AND now names the reason
 *     (`org_mismatch`) in the logs instead of vanishing into a bare 401.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { log } from "../../../src/observability/log.ts";
import type { WorkosAuth } from "../../../src/identity/instance.ts";
import { WorkosIdentityProvider } from "../../../src/identity/providers/workos.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";

// ── Key generation helpers (mirror workos-authkit.test.ts) ──────────

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
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// ── Setup ───────────────────────────────────────────────────────────

const CONFIGURED_ORG = "org_configured";
let workosKey: TestKeyPair;

const BASE_CONFIG: WorkosAuth = {
  adapter: "workos",
  clientId: "client_test_orgscope",
  redirectUri: "http://localhost/callback",
  organizationId: CONFIGURED_ORG,
  apiKey: "sk_test_fake_orgscope",
  // No authkitDomain → the WorkOS User Management branch (with the org_id gate)
  // is the one exercised, which is exactly the cookie-session path in prod.
};

beforeAll(async () => {
  workosKey = await generateRSAKeyPair("workos-key-1");
});

/** Captured options from the last authenticateWithRefreshToken call. */
interface RefreshCapture {
  last?: { clientId: string; refreshToken: string; organizationId?: string };
}

function createProvider(configOverrides?: Partial<WorkosAuth>): {
  provider: WorkosIdentityProvider;
  refreshCapture: RefreshCapture;
} {
  const config = { ...BASE_CONFIG, ...configOverrides };
  const workspaceStore = new WorkspaceStore(mkdtempSync(join(tmpdir(), "workos-orgscope-")));
  const provider = new WorkosIdentityProvider(config, undefined, workspaceStore);
  const refreshCapture: RefreshCapture = {};

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
      data: [{ id: "om_test", role: { slug: "member" }, status: "active", ...opts }],
    }),
    authenticateWithRefreshToken: async (opts: {
      clientId: string;
      refreshToken: string;
      organizationId?: string;
    }) => {
      refreshCapture.last = opts;
      return { accessToken: "new_access", refreshToken: "new_refresh" };
    },
  };

  provider.fetcher = async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
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

  return { provider, refreshCapture };
}

async function workosToken(orgId: string | undefined, sub = "user_orgscope"): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub,
    iss: "https://api.workos.com", // not the authkit issuer → WorkOS branch
    exp: nowSec + 3600,
    iat: nowSec,
  };
  if (orgId !== undefined) payload.org_id = orgId;
  return createJwt(payload, workosKey.privateKey, workosKey.kid);
}

function makeRequest(token: string): Request {
  return new Request("http://localhost:27247/v1/conversations", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── refreshToken pins the configured org (the fix) ──────────────────

describe("WorkosIdentityProvider.refreshToken org pinning", () => {
  it("passes the configured organizationId to authenticateWithRefreshToken", async () => {
    const { provider, refreshCapture } = createProvider();
    await provider.refreshToken("rt_abc");
    expect(refreshCapture.last?.refreshToken).toBe("rt_abc");
    expect(refreshCapture.last?.organizationId).toBe(CONFIGURED_ORG);
  });

  it("omits organizationId when no org is configured", async () => {
    const { provider, refreshCapture } = createProvider({ organizationId: undefined });
    await provider.refreshToken("rt_abc");
    expect(refreshCapture.last).toBeDefined();
    expect(refreshCapture.last?.organizationId).toBeUndefined();
  });
});

// ── verifyRequest org gate + reason instrumentation ─────────────────

describe("WorkosIdentityProvider.verifyRequest org_id gate", () => {
  it("accepts a token whose org_id matches the configured org", async () => {
    const { provider } = createProvider();
    const identity = await provider.verifyRequest(makeRequest(await workosToken(CONFIGURED_ORG)));
    expect(identity).not.toBeNull();
    expect(identity!.id).toBe("user_orgscope");
  });

  it("rejects a token whose org_id differs (the drifted-refresh case) and logs org_mismatch", async () => {
    const { provider } = createProvider();
    const warnSpy = spyOn(log, "warn");
    try {
      const identity = await provider.verifyRequest(
        makeRequest(await workosToken("org_some_other_org")),
      );
      expect(identity).toBeNull();
      // The previously-silent gate now names itself for operators.
      const orgMismatchCall = warnSpy.mock.calls.find((c) =>
        String(c[0]).includes("org_mismatch"),
      );
      expect(orgMismatchCall).toBeDefined();
      // Token-derived ids are stamped; the raw token never is.
      const fields = orgMismatchCall![1] as Record<string, unknown> | undefined;
      expect(fields).toMatchObject({
        claimed_org: "org_some_other_org",
        expected_org: CONFIGURED_ORG,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rejects a token with no org_id when an org is configured", async () => {
    const { provider } = createProvider();
    const identity = await provider.verifyRequest(makeRequest(await workosToken(undefined)));
    expect(identity).toBeNull();
  });

  it("rejects a token with an invalid signature and logs bad_signature", async () => {
    // Org matches and passes the gate, but the token is signed with a key the
    // WorkOS JWKS doesn't serve → signature verification fails. This is the
    // security-relevant path that must not be silent.
    const { provider } = createProvider();
    const wrongKey = await generateRSAKeyPair("not-in-jwks");
    const nowSec = Math.floor(Date.now() / 1000);
    const forged = await createJwt(
      { sub: "user_forged", iss: "https://api.workos.com", exp: nowSec + 3600, org_id: CONFIGURED_ORG },
      wrongKey.privateKey,
      wrongKey.kid,
    );
    const warnSpy = spyOn(log, "warn");
    try {
      const identity = await provider.verifyRequest(makeRequest(forged));
      expect(identity).toBeNull();
      const badSigCall = warnSpy.mock.calls.find((c) => String(c[0]).includes("bad_signature"));
      expect(badSigCall).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
