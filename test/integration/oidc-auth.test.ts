/**
 * Integration tests: OIDC Auth Flow
 *
 * End-to-end tests that validate the full OIDC chain:
 * instance config → factory → adapter → JWT verification → user provisioning → identity returned.
 *
 * Uses a real mock JWKS server (Bun.serve), real filesystem stores, and the
 * createIdentityProvider factory. No mocks beyond the OIDC provider itself.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createIdentityProvider } from "../../src/identity/provider.ts";
import { loadInstanceConfig, saveInstanceConfig } from "../../src/identity/instance.ts";
import { OidcIdentityProvider } from "../../src/identity/providers/oidc.ts";
import { UserStore } from "../../src/identity/user.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

// ── RSA key pair (generated once per suite) ───────────────────────

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;
const KID = "integ-key-1";

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  privateKey = keyPair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
});

// ── Mock OIDC provider (Bun.serve) ───────────────────────────────

let server: ReturnType<typeof Bun.serve>;
let issuer: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: `http://localhost:${server.port}`,
          jwks_uri: `http://localhost:${server.port}/jwks`,
        });
      }

      if (url.pathname === "/jwks") {
        return Response.json({
          keys: [
            {
              kty: publicJwk.kty,
              kid: KID,
              n: publicJwk.n,
              e: publicJwk.e,
              alg: "RS256",
              use: "sig",
            },
          ],
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });
  issuer = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

// ── Per-test temp directory ──────────────────────────────────────

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-oidc-integ-"));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── JWT builder helper ───────────────────────────────────────────

function base64UrlEncode(data: Uint8Array): string {
  const binary = String.fromCharCode(...data);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface TokenOptions {
  iss?: string;
  aud?: string;
  exp?: number;
  sub?: string;
  email?: string;
  name?: string;
  kid?: string;
}

async function buildJwt(opts: TokenOptions = {}): Promise<string> {
  const header = {
    alg: "RS256",
    typ: "JWT",
    kid: opts.kid ?? KID,
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    iss: opts.iss ?? issuer,
    aud: opts.aud ?? "my-client-id",
    exp: opts.exp ?? nowSec + 3600,
    sub: opts.sub ?? "integ-user-sub",
    email: opts.email ?? "alice@acme.com",
    name: opts.name,
  };

  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sigInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const sigBytes = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, sigInput);
  const sigB64 = base64UrlEncode(new Uint8Array(sigBytes));

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

function bearerRequest(token: string): Request {
  return new Request("http://localhost/v1/chat", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Tests ────────────────────────────────────────────────────────

const CLIENT_ID = "my-client-id";
const ALLOWED_DOMAINS = ["acme.com"];

describe("OIDC integration: full flow", () => {
  test("instance config → factory → adapter → JWT verify → user auto-provisioned → identity returned", async () => {
    // Write instance config with OIDC auth
    await saveInstanceConfig(workDir, {
      auth: {
        adapter: "oidc",
        issuer,
        clientId: CLIENT_ID,
        allowedDomains: ALLOWED_DOMAINS,
      },
    });

    // Load config back (as the runtime would)
    const config = await loadInstanceConfig(workDir);
    expect(config).not.toBeNull();
    expect(config!.auth.adapter).toBe("oidc");

    // Create stores and adapter via factory
    const userStore = new UserStore(workDir);
    const wsStore = new WorkspaceStore(workDir);
    const adapter = createIdentityProvider(config, userStore, new WorkspaceStore(workDir));
    expect(adapter).not.toBeNull();
    expect(adapter).toBeInstanceOf(OidcIdentityProvider);

    // Generate a valid JWT and verify
    const token = await buildJwt({ email: "alice@acme.com", sub: "alice-sub-1", name: "Alice" });
    const identity = await adapter!.verifyRequest(bearerRequest(token));

    expect(identity).not.toBeNull();
    expect(identity!.email).toBe("alice@acme.com");
    expect(identity!.displayName).toBe("Alice");
    expect(identity!.orgRole).toBe("member");
    expect(identity!.id).toMatch(/^usr_oidc_[0-9a-f]{12}$/);

    // User was persisted in the store
    const stored = await userStore.getByEmail("alice@acme.com");
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe(identity!.id);
  });

  test("second login returns same user (no duplicate)", async () => {
    const userStore = new UserStore(workDir);
    const adapter = new OidcIdentityProvider({ adapter: "oidc", issuer, clientId: CLIENT_ID, allowedDomains: ALLOWED_DOMAINS }, userStore, new WorkspaceStore(workDir));

    const sub = "repeat-integ-sub";
    const token1 = await buildJwt({ email: "bob@acme.com", sub, name: "Bob" });
    const id1 = await adapter.verifyRequest(bearerRequest(token1));
    expect(id1).not.toBeNull();

    const token2 = await buildJwt({ email: "bob@acme.com", sub, name: "Bob" });
    const id2 = await adapter.verifyRequest(bearerRequest(token2));
    expect(id2).not.toBeNull();

    // Same user ID
    expect(id1!.id).toBe(id2!.id);

    // Only one user in the store
    const all = await userStore.list();
    const bobs = all.filter((u) => u.email === "bob@acme.com");
    expect(bobs).toHaveLength(1);
  });

  test("auto-provisioned user can be added to workspace after OIDC login", async () => {
    const userStore = new UserStore(workDir);
    const wsStore = new WorkspaceStore(workDir);

    // Create a default workspace first
    const ws = await wsStore.create("Default");

    // OidcIdentityProvider no longer auto-adds to workspaces — that is handled
    // by the runtime layer. Verify the user is provisioned and can be manually added.
    const adapter = new OidcIdentityProvider({ adapter: "oidc", issuer, clientId: CLIENT_ID, allowedDomains: ALLOWED_DOMAINS }, userStore, new WorkspaceStore(workDir));
    const token = await buildJwt({ email: "carol@acme.com", sub: "carol-sub", name: "Carol" });
    const identity = await adapter.verifyRequest(bearerRequest(token));
    expect(identity).not.toBeNull();

    // Manually add the auto-provisioned user to the workspace (as the runtime would)
    await wsStore.addMember(ws.id, identity!.id, "member");

    // Verify workspace membership
    const updated = await wsStore.get(ws.id);
    expect(updated).not.toBeNull();
    const member = updated!.members.find((m) => m.userId === identity!.id);
    expect(member).not.toBeUndefined();
    expect(member!.role).toBe("member");
  });
});

describe("OIDC integration: domain rejection", () => {
  test("valid JWT with wrong domain is rejected and no user is created", async () => {
    const userStore = new UserStore(workDir);
    const adapter = new OidcIdentityProvider({ adapter: "oidc", issuer, clientId: CLIENT_ID, allowedDomains: ALLOWED_DOMAINS }, userStore, new WorkspaceStore(workDir));

    // JWT is cryptographically valid but email domain is not in allowedDomains
    const token = await buildJwt({ email: "eve@evil.com", sub: "evil-sub", name: "Eve" });
    const identity = await adapter.verifyRequest(bearerRequest(token));
    expect(identity).toBeNull();

    // No user was provisioned
    const users = await userStore.list();
    expect(users).toHaveLength(0);
  });

  test("factory-created adapter respects allowedDomains from instance config", async () => {
    await saveInstanceConfig(workDir, {
      auth: {
        adapter: "oidc",
        issuer,
        clientId: CLIENT_ID,
        allowedDomains: ["trusted.org"],
      },
    });

    const config = await loadInstanceConfig(workDir);
    const userStore = new UserStore(workDir);
    const adapter = createIdentityProvider(config, userStore, new WorkspaceStore(workDir));
    expect(adapter).not.toBeNull();

    // acme.com is not in allowedDomains for this config
    const tokenBad = await buildJwt({ email: "alice@acme.com", sub: "bad-domain-sub" });
    const rejected = await adapter!.verifyRequest(bearerRequest(tokenBad));
    expect(rejected).toBeNull();

    // trusted.org is allowed
    const tokenGood = await buildJwt({ email: "alice@trusted.org", sub: "good-domain-sub", name: "Alice" });
    const accepted = await adapter!.verifyRequest(bearerRequest(tokenGood));
    expect(accepted).not.toBeNull();
    expect(accepted!.email).toBe("alice@trusted.org");
  });
});

describe("OIDC integration: factory wiring", () => {
  test("loadInstanceConfig with oidc adapter → createIdentityProvider returns OidcIdentityProvider", async () => {
    await saveInstanceConfig(workDir, {
      auth: {
        adapter: "oidc",
        issuer,
        clientId: CLIENT_ID,
        allowedDomains: ALLOWED_DOMAINS,
      },
    });

    const config = await loadInstanceConfig(workDir);
    const userStore = new UserStore(workDir);
    const adapter = createIdentityProvider(config, userStore, new WorkspaceStore(workDir));

    expect(adapter).toBeInstanceOf(OidcIdentityProvider);
  });

  test("null config (dev mode) returns null adapter", () => {
    const userStore = new UserStore(workDir);
    const adapter = createIdentityProvider(null, userStore, new WorkspaceStore(workDir));
    expect(adapter).toBeNull();
  });

  test("admin-created user is found by OIDC login without duplication", async () => {
    const userStore = new UserStore(workDir);
    const adapter = new OidcIdentityProvider({ adapter: "oidc", issuer, clientId: CLIENT_ID, allowedDomains: ALLOWED_DOMAINS }, userStore, new WorkspaceStore(workDir));

    // Admin pre-creates user with admin role
    const adminUser = await userStore.create({
      email: "dave@acme.com",
      displayName: "Dave (Admin)",
      orgRole: "admin",
    });

    // Dave logs in via OIDC
    const token = await buildJwt({ email: "dave@acme.com", sub: "dave-oidc-sub", name: "Dave OIDC" });
    const identity = await adapter.verifyRequest(bearerRequest(token));
    expect(identity).not.toBeNull();

    // Returns the admin-created user, not a new one
    expect(identity!.id).toBe(adminUser.id);
    expect(identity!.orgRole).toBe("admin"); // Preserved, not downgraded
    expect(identity!.displayName).toBe("Dave (Admin)"); // Not overwritten

    // Only one user in the store
    const all = await userStore.list();
    const daves = all.filter((u) => u.email === "dave@acme.com");
    expect(daves).toHaveLength(1);
  });
});
