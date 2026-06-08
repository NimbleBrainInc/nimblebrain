import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthorizationServerMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildTenantAssertion } from "../../src/oauth/fleet-assertion.ts";
import { signEnvelope, verifyEnvelopeAsTenant } from "../../src/oauth/envelope.ts";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";

// Cross-implementation drift guard. This wire is shared verbatim with the
// authorizer that verifies the assertion, which asserts it accepts it. Here we
// assert our signer reproduces it byte-for-byte. If the two implementations
// drift on HKDF info / MAC framing / payload shape / lifetime cap, exactly one
// side breaks and CI catches it.
const VECTOR = JSON.parse(
  readFileSync(new URL("./fixtures/authorizer-cross-impl-v1.json", import.meta.url), "utf8"),
) as { masterKeyB64: string; tid: string; inner: string; iat: number; ttlSeconds: number; wire: string };

describe("cross-impl vector (authorizer parity)", () => {
  it("signEnvelope reproduces the committed wire byte-for-byte", () => {
    const master = Buffer.from(VECTOR.masterKeyB64, "base64");
    // The runtime holds this key pre-derived under the authorizer info string.
    const tenantKey = Buffer.from(
      hkdfSync("sha256", master, Buffer.from(VECTOR.tid, "utf8"), Buffer.from("mcp-authorizer/v1"), 32),
    );
    const wire = signEnvelope({
      tid: VECTOR.tid,
      inner: VECTOR.inner,
      tenantKey,
      now: VECTOR.iat,
      ttlSeconds: VECTOR.ttlSeconds,
    });
    expect(wire).toBe(VECTOR.wire);
  });
});

const KEY = randomBytes(32);
const KEY_B64 = KEY.toString("base64");
const FLEET_ISSUER = "https://fleet-authorizer.internal";

const savedTid = process.env.NB_TENANT_ID;
const savedKey = process.env.NB_MCP_AUTHORIZER_TENANT_KEY;
function setEnv(tid?: string, key?: string) {
  if (tid === undefined) delete process.env.NB_TENANT_ID;
  else process.env.NB_TENANT_ID = tid;
  if (key === undefined) delete process.env.NB_MCP_AUTHORIZER_TENANT_KEY;
  else process.env.NB_MCP_AUTHORIZER_TENANT_KEY = key;
}
afterEach(() => setEnv(savedTid, savedKey));

const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

describe("buildTenantAssertion", () => {
  it("returns null when the tenant id or key is not provisioned", () => {
    setEnv(undefined, undefined);
    expect(buildTenantAssertion({ inner: "chal" })).toBeNull();
    setEnv("tenant-x", undefined);
    expect(buildTenantAssertion({ inner: "chal" })).toBeNull();
    setEnv(undefined, KEY_B64);
    expect(buildTenantAssertion({ inner: "chal" })).toBeNull();
  });

  it("signs an assertion the tenant key verifies, carrying the bound inner", () => {
    setEnv("tenant-x", KEY_B64);
    const wire = buildTenantAssertion({ inner: "challenge-abc" });
    expect(wire).not.toBeNull();
    const payload = verifyEnvelopeAsTenant({
      wire: wire as string,
      tenantKey: KEY,
      expectedTid: "tenant-x",
    });
    expect(payload.inner).toBe("challenge-abc");
  });

  it("throws on a truncated key rather than minting a junk assertion", () => {
    setEnv("tenant-x", randomBytes(16).toString("base64"));
    expect(() => buildTenantAssertion({ inner: "chal" })).toThrow();
  });
});

describe("WorkspaceOAuthProvider.addClientAuthentication", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-fleet-test-"));
  });

  function provider(fleetAuthorizerIssuer?: string) {
    return new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "fleet-srv",
      workDir,
      callbackUrl: "http://localhost:27247/v1/mcp-auth/callback",
      ...(fleetAuthorizerIssuer ? { fleetAuthorizerIssuer } : {}),
    });
  }
  function params(verifier = "the-verifier") {
    return new URLSearchParams({ grant_type: "authorization_code", code: "c", code_verifier: verifier });
  }

  // The hook fires through the property the SDK actually destructures. Asserting
  // it's defined here is also the contract that the fleet path is wired at all.
  function fleetHook(fleetAuthorizerIssuer: string) {
    const hook = provider(fleetAuthorizerIssuer).addClientAuthentication;
    expect(hook).toBeDefined();
    return hook as NonNullable<typeof hook>;
  }

  it("is NOT installed when no fleet issuer is configured (SDK default client auth runs)", () => {
    // The contract for 'runs locally with none of it': with no issuer the
    // provider leaves addClientAuthentication undefined, so the MCP SDK uses its
    // own built-in client authentication and zero fleet code touches the token
    // path. This is what makes the local/self-host path bulletproof.
    expect(provider(undefined).addClientAuthentication).toBeUndefined();
  });

  it("attaches an assertion bound to the PKCE challenge for the fleet token endpoint", async () => {
    setEnv("tenant-x", KEY_B64);
    const p = params();
    await fleetHook(FLEET_ISSUER)(new Headers(), p, `${FLEET_ISSUER}/token`);
    const wire = p.get("tenant_assertion");
    expect(wire).toBeTruthy();
    const payload = verifyEnvelopeAsTenant({ wire: wire as string, tenantKey: KEY, expectedTid: "tenant-x" });
    expect(payload.inner).toBe(s256("the-verifier"));
  });

  it("never attaches to a vendor token endpoint (no key-signature leak)", async () => {
    setEnv("tenant-x", KEY_B64);
    const p = params();
    await fleetHook(FLEET_ISSUER)(new Headers(), p, "https://oauth2.googleapis.com/token");
    expect(p.get("tenant_assertion")).toBeNull();
  });

  it("no-ops gracefully when the tenant key is not provisioned (rollout phase 1)", async () => {
    setEnv("tenant-x", undefined);
    const p = params();
    await fleetHook(FLEET_ISSUER)(new Headers(), p, `${FLEET_ISSUER}/token`);
    expect(p.get("tenant_assertion")).toBeNull();
  });
});

// Step 1 of the fleet hook reproduces the SDK's default client authentication
// (applyClientAuthentication), which the SDK does NOT export. Once the hook is
// installed it owns client auth for EVERY token endpoint in a fleet deployment
// (the authorizer AND every vendor), so a drifted mirror would break all token
// exchanges. These tests pin the mirror against the SDK's exported
// selectClientAuthMethod across all three auth methods. A static client supplies
// client info without disk DCR. (Before the hook was gated, this path was
// covered incidentally by the OAuth integration tests; gating removed that, so
// it must be covered explicitly here.)
describe("fleet hook — SDK client-auth parity (step 1)", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-fleet-clientauth-"));
    setEnv(undefined, undefined); // step 1 only; no tenant assertion
  });

  function hookWithStaticClient(staticClient: {
    clientId: string;
    clientSecret?: string;
  }) {
    const provider = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "fleet-srv",
      workDir,
      callbackUrl: "http://localhost:27247/v1/mcp-auth/callback",
      fleetAuthorizerIssuer: FLEET_ISSUER,
      staticClient,
    });
    const hook = provider.addClientAuthentication;
    expect(hook).toBeDefined();
    return hook as NonNullable<typeof hook>;
  }

  const tokenParams = () => new URLSearchParams({ grant_type: "authorization_code" });

  it("public client (no secret) → client_id in body (method 'none')", async () => {
    const p = tokenParams();
    await hookWithStaticClient({ clientId: "pub-client" })(new Headers(), p, `${FLEET_ISSUER}/token`);
    expect(p.get("client_id")).toBe("pub-client");
    expect(p.get("client_secret")).toBeNull();
  });

  it("confidential client, no server metadata → HTTP Basic (method 'client_secret_basic')", async () => {
    const headers = new Headers();
    const p = tokenParams();
    await hookWithStaticClient({ clientId: "cid", clientSecret: "s3cret" })(
      headers,
      p,
      `${FLEET_ISSUER}/token`,
    );
    expect(headers.get("Authorization")).toBe(`Basic ${btoa("cid:s3cret")}`);
    // Basic auth carries the id in the header, NOT the body.
    expect(p.get("client_id")).toBeNull();
  });

  it("confidential client, server advertises client_secret_post → id+secret in body", async () => {
    const headers = new Headers();
    const p = tokenParams();
    const metadata = {
      issuer: FLEET_ISSUER,
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    } as AuthorizationServerMetadata;
    await hookWithStaticClient({ clientId: "cid", clientSecret: "s3cret" })(
      headers,
      p,
      `${FLEET_ISSUER}/token`,
      metadata,
    );
    expect(p.get("client_id")).toBe("cid");
    expect(p.get("client_secret")).toBe("s3cret");
    expect(headers.get("Authorization")).toBeNull();
  });
});
