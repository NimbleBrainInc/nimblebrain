import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OidcIdentityProvider } from "../../../src/identity/providers/oidc.ts";
import { UserStore } from "../../../src/identity/user.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import { fakeFetch } from "../../helpers/fake-fetch.ts";

// ── RSA key pair (generated once per suite) ───────────────────────

let privateKey: CryptoKey;
let publicJwk: webcrypto.JsonWebKey;
const KID = "test-key-1";

beforeAll(async () => {
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
  privateKey = keyPair.privateKey;
  publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
});

// ── Mock OIDC provider (Bun.serve) ───────────────────────────────

let server: ReturnType<typeof Bun.serve>;
let issuer: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0, // random available port
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

// ── Per-test setup ────────────────────────────────────────────────

let workDir: string;
let userStore: UserStore;
let workspaceStore: WorkspaceStore;
let adapter: OidcIdentityProvider;
const CLIENT_ID = "my-client-id";
const ALLOWED_DOMAINS = ["example.com", "corp.io"];

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-oidc-test-"));
  userStore = new UserStore(workDir);
  workspaceStore = new WorkspaceStore(workDir);
  adapter = new OidcIdentityProvider(
    { adapter: "oidc", issuer, clientId: CLIENT_ID, allowedDomains: ALLOWED_DOMAINS },
    userStore,
  );
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

// ── JWT builder helper ────────────────────────────────────────────

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
  /** Defaults to `true`; pass `undefined` explicitly to omit the claim. */
  email_verified?: unknown;
  name?: string;
  given_name?: string;
  family_name?: string;
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
    aud: opts.aud ?? CLIENT_ID,
    exp: opts.exp ?? nowSec + 3600,
    sub: opts.sub ?? "user-123",
    email: opts.email ?? "alice@example.com",
    email_verified: "email_verified" in opts ? opts.email_verified : true,
    name: opts.name,
    given_name: opts.given_name,
    family_name: opts.family_name,
  };

  const headerB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sigInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const sigBytes = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, sigInput);
  const sigB64 = base64UrlEncode(new Uint8Array(sigBytes));

  return `${headerB64}.${payloadB64}.${sigB64}`;
}

function bearerRequest(token: string): Request {
  return new Request("http://localhost/test", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

// ── Tests ─────────────────────────────────────────────────────────

describe("OidcIdentityProvider", () => {
  describe("verifyRequest", () => {
    test("valid JWT with correct issuer/audience/domain returns UserIdentity", async () => {
      // Pre-create the user (task 001 does NOT auto-provision)
      await userStore.create({
        email: "alice@example.com",
        displayName: "Alice",
        orgRole: "member",
      });

      const token = await buildJwt({ email: "alice@example.com" });
      const identity = await adapter.verifyRequest(bearerRequest(token));

      expect(identity).not.toBeNull();
      expect(identity!.email).toBe("alice@example.com");
      expect(identity!.orgRole).toBe("member");
    });

    test("valid JWT for unknown user auto-provisions with member role", async () => {
      const token = await buildJwt({
        email: "nobody@example.com",
        sub: "oidc-sub-123",
        name: "Nobody Test",
      });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).not.toBeNull();
      expect(identity!.email).toBe("nobody@example.com");
      expect(identity!.orgRole).toBe("member");
      expect(identity!.displayName).toBe("Nobody Test");
      expect(identity!.id).toMatch(/^usr_oidc_[0-9a-f]{12}$/);
    });

    test("authentication creates no workspace (bootstrap provisions)", async () => {
      const token = await buildJwt({
        email: "carol@example.com",
        sub: "oidc-sub-carol",
        name: "Carol",
      });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).not.toBeNull();
      expect(await workspaceStore.getWorkspacesForUser(identity!.id)).toHaveLength(0);
    });

    test("expired JWT returns null", async () => {
      await userStore.create({ email: "alice@example.com", displayName: "Alice" });

      const token = await buildJwt({
        email: "alice@example.com",
        exp: Math.floor(Date.now() / 1000) - 60,
      });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).toBeNull();
    });

    test("wrong issuer returns null", async () => {
      await userStore.create({ email: "alice@example.com", displayName: "Alice" });

      const token = await buildJwt({ email: "alice@example.com", iss: "https://evil.example.com" });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).toBeNull();
    });

    test("wrong audience returns null", async () => {
      await userStore.create({ email: "alice@example.com", displayName: "Alice" });

      const token = await buildJwt({ email: "alice@example.com", aud: "wrong-client-id" });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).toBeNull();
    });

    test("email domain not in allowedDomains returns null", async () => {
      await userStore.create({ email: "alice@evil.com", displayName: "Alice" });

      const token = await buildJwt({ email: "alice@evil.com" });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).toBeNull();
    });

    test("domain check is case-insensitive", async () => {
      await userStore.create({ email: "alice@EXAMPLE.COM", displayName: "Alice" });

      const token = await buildJwt({ email: "alice@EXAMPLE.COM" });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).not.toBeNull();
    });

    test("missing Bearer token returns null", async () => {
      const req = new Request("http://localhost/test");
      const identity = await adapter.verifyRequest(req);
      expect(identity).toBeNull();
    });

    test("malformed JWT returns null (no crash)", async () => {
      const identity = await adapter.verifyRequest(bearerRequest("not.a.jwt"));
      expect(identity).toBeNull();
    });

    test("completely garbage token returns null", async () => {
      const identity = await adapter.verifyRequest(bearerRequest("garbage"));
      expect(identity).toBeNull();
    });

    test("JWT with wrong kid returns null", async () => {
      await userStore.create({ email: "alice@example.com", displayName: "Alice" });

      const token = await buildJwt({ email: "alice@example.com", kid: "nonexistent-key" });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).toBeNull();
    });
  });

  describe("JWKS caching", () => {
    test("reuses cached JWKS within TTL", async () => {
      await userStore.create({ email: "alice@example.com", displayName: "Alice" });

      let fetchCount = 0;
      const originalFetch = adapter.fetcher;
      adapter.fetcher = fakeFetch(async (...args: Parameters<typeof fetch>) => {
        fetchCount++;
        return originalFetch(...args);
      });

      const token1 = await buildJwt({ email: "alice@example.com" });
      await adapter.verifyRequest(bearerRequest(token1));

      // discovery + jwks = 2 fetches
      expect(fetchCount).toBe(2);

      const token2 = await buildJwt({ email: "alice@example.com" });
      await adapter.verifyRequest(bearerRequest(token2));

      // Should still be 2 — JWKS served from cache
      expect(fetchCount).toBe(2);
    });

    test("refetches JWKS after TTL expires", async () => {
      await userStore.create({ email: "alice@example.com", displayName: "Alice" });

      let fetchCount = 0;
      const originalFetch = adapter.fetcher;
      adapter.fetcher = fakeFetch(async (...args: Parameters<typeof fetch>) => {
        fetchCount++;
        return originalFetch(...args);
      });

      // Freeze time
      let fakeNow = Date.now();
      adapter.now = () => fakeNow;

      const token1 = await buildJwt({ email: "alice@example.com" });
      await adapter.verifyRequest(bearerRequest(token1));
      expect(fetchCount).toBe(2);

      // Advance past 5-minute TTL
      fakeNow += 6 * 60 * 1000;

      const token2 = await buildJwt({ email: "alice@example.com" });
      await adapter.verifyRequest(bearerRequest(token2));

      // Should have refetched JWKS (discovery cached, jwks refetched)
      expect(fetchCount).toBe(3);
    });
  });

  describe("listUsers", () => {
    test("delegates to UserStore", async () => {
      await userStore.create({ email: "a@example.com", displayName: "A" });
      await userStore.create({ email: "b@example.com", displayName: "B" });

      const users = await adapter.listUsers();
      expect(users).toHaveLength(2);
    });
  });

  describe("createUser", () => {
    test("delegates to UserStore.create()", async () => {
      const { user } = await adapter.createUser({
        email: "new@example.com",
        displayName: "New User",
        orgRole: "admin",
      });
      expect(user.email).toBe("new@example.com");
      expect(user.orgRole).toBe("admin");

      const fetched = await userStore.getByEmail("new@example.com");
      expect(fetched).not.toBeNull();
    });
  });

  describe("deleteUser", () => {
    test("delegates to UserStore.delete()", async () => {
      const user = await userStore.create({ email: "del@example.com", displayName: "Del" });
      const result = await adapter.deleteUser(user.id);
      expect(result).toBe(true);

      const fetched = await userStore.get(user.id);
      expect(fetched).toBeNull();
    });

    test("returns false for nonexistent user", async () => {
      const result = await adapter.deleteUser("usr_nonexistent12345");
      expect(result).toBe(false);
    });
  });

  describe("profile fields", () => {
    test("email is provider-owned, since sign-in falls back to matching it", () => {
      expect(adapter.capabilities.providerOwnedUserFields).toEqual(["email"]);
    });
  });

  describe("OIDC auto-provisioning", () => {
    test("second login with same sub returns same user (no duplicate)", async () => {
      const sub = "repeat-login-sub";
      const token1 = await buildJwt({ email: "repeat@example.com", sub, name: "Repeat User" });
      const id1 = await adapter.verifyRequest(bearerRequest(token1));
      expect(id1).not.toBeNull();

      const token2 = await buildJwt({ email: "repeat@example.com", sub, name: "Repeat User" });
      const id2 = await adapter.verifyRequest(bearerRequest(token2));
      expect(id2).not.toBeNull();

      expect(id1!.id).toBe(id2!.id);

      // Only one user in the store
      const users = await userStore.list();
      const matching = users.filter((u) => u.email === "repeat@example.com");
      expect(matching).toHaveLength(1);
    });

    test("display name extracted from name claim", async () => {
      const token = await buildJwt({
        email: "named@example.com",
        sub: "named-sub",
        name: "Alice Smith",
      });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity!.displayName).toBe("Alice Smith");
    });

    test("display name falls back to given_name + family_name", async () => {
      const token = await buildJwt({
        email: "parts@example.com",
        sub: "parts-sub",
        given_name: "Bob",
        family_name: "Jones",
      });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity!.displayName).toBe("Bob Jones");
    });

    test("display name falls back to email when no name claims", async () => {
      const token = await buildJwt({ email: "noname@example.com", sub: "noname-sub" });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity!.displayName).toBe("noname@example.com");
    });

    test("existing user (created by admin) is found and returned without modification", async () => {
      const adminUser = await userStore.create({
        email: "admin-created@example.com",
        displayName: "Admin Created",
        orgRole: "admin",
      });

      const token = await buildJwt({
        email: "admin-created@example.com",
        sub: "admin-sub",
        name: "Different Name",
      });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).not.toBeNull();
      expect(identity!.id).toBe(adminUser.id);
      expect(identity!.displayName).toBe("Admin Created"); // Not overwritten
      expect(identity!.orgRole).toBe("admin"); // Not downgraded
    });

    test("auto-provisioned user can be added to workspace after creation", async () => {
      const wsStore = new WorkspaceStore(workDir);
      const ws = await wsStore.create("Default Workspace");

      // OidcIdentityProvider no longer auto-adds to workspaces — that is handled
      // by the runtime layer. Verify the user is provisioned and can be manually added.
      const token = await buildJwt({
        email: "ws-user@example.com",
        sub: "ws-sub",
        name: "WS User",
      });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).not.toBeNull();

      // Manually add the auto-provisioned user to the workspace (as the runtime would)
      await wsStore.addMember(ws.id, identity!.id, "member");

      // Check workspace membership
      const updatedWs = await wsStore.get(ws.id);
      expect(updatedWs).not.toBeNull();
      const member = updatedWs!.members.find((m) => m.userId === identity!.id);
      expect(member).not.toBeUndefined();
      expect(member!.role).toBe("member");
    });

    test("email domain not in allowedDomains rejects auto-provisioning", async () => {
      const token = await buildJwt({ email: "hacker@evil.com", sub: "evil-sub" });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).toBeNull();

      // No user should have been created
      const users = await userStore.list();
      const matching = users.filter((u) => u.email === "hacker@evil.com");
      expect(matching).toHaveLength(0);
    });

    test("domain check is case-insensitive for auto-provisioning", async () => {
      const token = await buildJwt({ email: "upper@EXAMPLE.COM", sub: "upper-sub", name: "Upper" });
      const identity = await adapter.verifyRequest(bearerRequest(token));
      expect(identity).not.toBeNull();
      expect(identity!.email).toBe("upper@EXAMPLE.COM");
    });

    test("user ID is deterministic from sub claim", async () => {
      const sub = "deterministic-test-sub";
      const token1 = await buildJwt({ email: "det1@example.com", sub, name: "Det" });
      const id1 = await adapter.verifyRequest(bearerRequest(token1));

      // Create a fresh adapter + stores to prove determinism
      const workDir2 = await mkdtemp(join(tmpdir(), "nb-oidc-det-"));
      const userStore2 = new UserStore(workDir2);
      const adapter2 = new OidcIdentityProvider(
        { adapter: "oidc", issuer, clientId: CLIENT_ID, allowedDomains: ALLOWED_DOMAINS },
        userStore2,
      );

      const token2 = await buildJwt({ email: "det2@example.com", sub, name: "Det" });
      const id2 = await adapter2.verifyRequest(bearerRequest(token2));

      expect(id1!.id).toBe(id2!.id);

      await rm(workDir2, { recursive: true, force: true });
    });
  });

  describe("subject binding", () => {
    test("first sign-in by email binds the subject to the pre-created record", async () => {
      const created = await userStore.create({
        email: "pre@example.com",
        displayName: "Pre",
        orgRole: "admin",
      });

      const identity = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "pre@example.com", sub: "pre-sub" })),
      );
      expect(identity!.id).toBe(created.id);
      expect((await userStore.get(created.id))!.identity).toBe(`${issuer}#pre-sub`);
    });

    test("a later sign-in with the same subject and a changed email finds the same record", async () => {
      const created = await userStore.create({ email: "old@example.com", displayName: "Old" });
      await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "old@example.com", sub: "moving-sub" })),
      );

      const identity = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "new@example.com", sub: "moving-sub" })),
      );
      expect(identity!.id).toBe(created.id);
      expect(await userStore.list()).toHaveLength(1);
    });

    test("a new subject with a bound record's email is refused and creates no record", async () => {
      const created = await userStore.create({
        email: "taken@example.com",
        displayName: "Taken",
        orgRole: "admin",
      });
      await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "taken@example.com", sub: "first-sub" })),
      );

      const identity = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "taken@example.com", sub: "second-sub" })),
      );
      expect(identity).toBeNull();
      const users = await userStore.list();
      expect(users).toHaveLength(1);
      expect(users[0]!.id).toBe(created.id);
      expect(users[0]!.identity).toBe(`${issuer}#first-sub`);
    });

    test("an auto-provisioned user is bound at creation and found by subject", async () => {
      const first = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "auto@example.com", sub: "auto-sub" })),
      );
      const stored = await userStore.get(first!.id);
      expect(stored!.identity).toBe(`${issuer}#auto-sub`);

      const again = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "auto-renamed@example.com", sub: "auto-sub" })),
      );
      expect(again!.id).toBe(first!.id);

      const other = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "auto@example.com", sub: "someone-else" })),
      );
      expect(other).toBeNull();
      expect(await userStore.list()).toHaveLength(1);
    });

    test("an auto-provisioned record from before binding binds on its next sign-in", async () => {
      const first = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "legacy@example.com", sub: "legacy-sub" })),
      );
      await userStore.update(first!.id, { identity: undefined });

      const again = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "legacy@example.com", sub: "legacy-sub" })),
      );
      expect(again!.id).toBe(first!.id);
      expect((await userStore.get(first!.id))!.identity).toBe(`${issuer}#legacy-sub`);
    });

    test("an unbound auto-provisioned record is not claimed by email; its own subject still binds it", async () => {
      const first = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "kept@example.com", sub: "owner-sub" })),
      );
      await userStore.update(first!.id, { identity: undefined });

      const newcomer = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "kept@example.com", sub: "newcomer-sub" })),
      );
      expect(newcomer).toBeNull();
      expect(await userStore.list()).toHaveLength(1);

      const original = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "kept@example.com", sub: "owner-sub" })),
      );
      expect(original!.id).toBe(first!.id);
      expect((await userStore.get(first!.id))!.identity).toBe(`${issuer}#owner-sub`);
    });

    test("the same subject from another issuer is refused and creates no record", async () => {
      const first = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "iss@example.com", sub: "shared-sub" })),
      );
      expect(first).not.toBeNull();

      const otherIssuer = `${issuer}/other`;
      const otherAdapter = new OidcIdentityProvider(
        {
          adapter: "oidc",
          issuer: otherIssuer,
          clientId: CLIENT_ID,
          allowedDomains: ALLOWED_DOMAINS,
          jwksUri: `${issuer}/jwks`,
        },
        userStore,
      );
      const sameSub = await otherAdapter.verifyRequest(
        bearerRequest(
          await buildJwt({ iss: otherIssuer, email: "iss2@example.com", sub: "shared-sub" }),
        ),
      );
      expect(sameSub).toBeNull();

      const sameEmail = await otherAdapter.verifyRequest(
        bearerRequest(
          await buildJwt({ iss: otherIssuer, email: "iss@example.com", sub: "fresh-sub" }),
        ),
      );
      expect(sameEmail).toBeNull();
      expect(await userStore.list()).toHaveLength(1);
    });
  });

  describe("email verification", () => {
    async function preCreated() {
      return userStore.create({
        email: "owner@example.com",
        displayName: "Owner",
        orgRole: "admin",
      });
    }

    test("an unverified email does not claim a pre-created record and creates none", async () => {
      const created = await preCreated();

      const identity = await adapter.verifyRequest(
        bearerRequest(
          await buildJwt({
            email: "owner@example.com",
            sub: "attacker-sub",
            email_verified: false,
          }),
        ),
      );
      expect(identity).toBeNull();
      const users = await userStore.list();
      expect(users).toHaveLength(1);
      expect(users[0]!.id).toBe(created.id);
      expect(users[0]!.identity).toBeUndefined();
    });

    test("a missing email_verified claim is treated as unverified", async () => {
      const created = await preCreated();

      const identity = await adapter.verifyRequest(
        bearerRequest(
          await buildJwt({
            email: "owner@example.com",
            sub: "attacker-sub",
            email_verified: undefined,
          }),
        ),
      );
      expect(identity).toBeNull();
      const users = await userStore.list();
      expect(users).toHaveLength(1);
      expect(users[0]!.identity).toBeUndefined();
      expect(users[0]!.id).toBe(created.id);
    });

    test("a truthy non-boolean email_verified is treated as unverified", async () => {
      await preCreated();
      const identity = await adapter.verifyRequest(
        bearerRequest(
          await buildJwt({
            email: "owner@example.com",
            sub: "attacker-sub",
            email_verified: "true",
          }),
        ),
      );
      expect(identity).toBeNull();
      expect((await userStore.list())[0]!.identity).toBeUndefined();
    });

    test("a verified email claims the pre-created record and binds it", async () => {
      const created = await preCreated();

      const identity = await adapter.verifyRequest(
        bearerRequest(
          await buildJwt({ email: "owner@example.com", sub: "owner-sub", email_verified: true }),
        ),
      );
      expect(identity!.id).toBe(created.id);
      expect(identity!.orgRole).toBe("admin");
      expect((await userStore.get(created.id))!.identity).toBe(`${issuer}#owner-sub`);
    });

    test("an unverified email does not auto-provision a new record", async () => {
      for (const email_verified of [false, undefined]) {
        const identity = await adapter.verifyRequest(
          bearerRequest(
            await buildJwt({ email: "new@example.com", sub: "new-sub", email_verified }),
          ),
        );
        expect(identity).toBeNull();
      }
      expect(await userStore.list()).toHaveLength(0);
    });

    test("a bound user whose token's email is unverified is refused", async () => {
      const first = await adapter.verifyRequest(
        bearerRequest(await buildJwt({ email: "bound@example.com", sub: "bound-sub" })),
      );
      expect(first).not.toBeNull();

      const again = await adapter.verifyRequest(
        bearerRequest(
          await buildJwt({ email: "bound@example.com", sub: "bound-sub", email_verified: false }),
        ),
      );
      expect(again).toBeNull();
    });
  });
});
