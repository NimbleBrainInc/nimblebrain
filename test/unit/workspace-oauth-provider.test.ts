import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { log } from "../../src/cli/log.ts";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";
import { WorkspaceContext } from "../../src/workspace/context.ts";

// Bun.serve-based cases (headless single-hop, headless multi-hop, interactive
// 302, interactive 200, SSRF block) live in
// `test/integration/workspace-oauth-provider.test.ts`, per AGENTS.md:
// "If a test calls Runtime.start(), startServer(), Bun.serve(), or
//  spawnSync(), it belongs in test/integration/."
// This unit file covers file-IO roundtrips and `awaitPendingFlow` guards
// that don't need a real HTTP target.

const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";

function makeProvider(workDir: string, serverName = "test-srv"): WorkspaceOAuthProvider {
  return new WorkspaceOAuthProvider({
    owner: { type: "workspace", wsId: "ws_test" },
    serverName,
    workDir,
    callbackUrl: CALLBACK,
  });
}

describe("WorkspaceOAuthProvider — file I/O roundtrips", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-test-"));
  });

  it("roundtrips client information via files", async () => {
    const p = makeProvider(workDir);
    const info: OAuthClientInformationFull = {
      client_id: "cid-123",
      redirect_uris: [CALLBACK],
    };
    await p.saveClientInformation(info);

    const read = await p.clientInformation();
    expect(read).toEqual(info);

    // Second provider instance (no in-memory cache) should see the file
    const p2 = makeProvider(workDir);
    const read2 = await p2.clientInformation();
    expect(read2).toEqual(info);
  });

  it("roundtrips tokens via files", async () => {
    const p = makeProvider(workDir);
    const tokens: OAuthTokens = {
      access_token: "acc",
      token_type: "Bearer",
      refresh_token: "ref",
      expires_in: 3600,
    };
    await p.saveTokens(tokens);

    const p2 = makeProvider(workDir);
    const read = await p2.tokens();
    expect(read).toEqual(tokens);
  });

  it("verifier roundtrip + codeVerifier missing throws", async () => {
    const p = makeProvider(workDir);
    await p.saveCodeVerifier("pkce-verifier-xyz");
    expect(await p.codeVerifier()).toBe("pkce-verifier-xyz");

    await p.invalidateCredentials("verifier");
    await expect(p.codeVerifier()).rejects.toThrow(/verifier missing/);
  });

  it("invalidateCredentials removes tokens but keeps client info on 'tokens' scope", async () => {
    const p = makeProvider(workDir);
    await p.saveClientInformation({ client_id: "cid", redirect_uris: [CALLBACK] });
    await p.saveTokens({ access_token: "a", token_type: "Bearer" });

    await p.invalidateCredentials("tokens");

    const p2 = makeProvider(workDir);
    expect(await p2.tokens()).toBeUndefined();
    expect(await p2.clientInformation()).toBeDefined();
  });

  it("clientInformation discards a cached client whose redirect_uri doesn't match the current callback", async () => {
    // Simulate the operational case: a DCR client was registered when
    // NB_API_URL was the dev default (or wrong), then the operator set
    // NB_API_URL on the deploy and the provider's callbackUrl flipped.
    // Returning the stale client.json would send the AS a redirect_uri
    // the registered client doesn't allow, surfacing as
    // `Invalid redirect_uri for OAuth client` after the user has
    // already clicked Connect.
    const stalePath = "http://localhost:27247/v1/mcp-auth/callback";
    const livePath = "https://hq.platform.nimblebrain.ai/v1/mcp-auth/callback";

    // Provider 1 writes a client with the stale redirect_uri.
    const p1 = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "drift-srv",
      workDir,
      callbackUrl: stalePath,
    });
    await p1.saveClientInformation({ client_id: "cid-stale", redirect_uris: [stalePath] });
    expect(await p1.clientInformation()).toBeDefined();

    // Provider 2 (fresh process, current deploy) reads the same dir
    // but with the live callback URL. The cached client is stale —
    // expect undefined so the SDK re-registers.
    const p2 = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "drift-srv",
      workDir,
      callbackUrl: livePath,
    });
    expect(await p2.clientInformation()).toBeUndefined();

    // And the on-disk client.json should be gone — drift detection
    // unlinks it so a subsequent saveClientInformation writes a fresh
    // record matching the current redirect URI.
    const p3 = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "drift-srv",
      workDir,
      callbackUrl: livePath,
    });
    expect(await p3.clientInformation()).toBeUndefined();
  });

  it("clientInformation accepts a cached client with multiple redirect_uris when one matches the current callback", async () => {
    // Defensive — some authorization servers seed multiple URIs on a
    // single client (test + prod). Don't false-positive drift when the
    // current callback is on the list, just not first.
    const cb = "https://hq.platform.nimblebrain.ai/v1/mcp-auth/callback";
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "multi-uri",
      workDir,
      callbackUrl: cb,
    });
    await p.saveClientInformation({
      client_id: "cid-multi",
      redirect_uris: ["https://other.example.com/cb", cb],
    });
    expect(await p.clientInformation()).toBeDefined();
  });

  it("files are written under <workDir>/workspaces/<wsId>/credentials/mcp-oauth/<serverName>/", async () => {
    const p = makeProvider(workDir, "my-server");
    const tokens: OAuthTokens = { access_token: "a", token_type: "Bearer" };
    await p.saveTokens(tokens);

    const expectedPath = join(
      workDir,
      "workspaces",
      "ws_test",
      "credentials",
      "mcp-oauth",
      "my-server",
      "tokens.json",
    );
    const onDisk = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(onDisk).toEqual(tokens);
  });

  it("awaitPendingFlow without state() throws (no active flow)", async () => {
    const p = makeProvider(workDir);
    await expect(p.awaitPendingFlow()).rejects.toThrow(/no active flow/i);
  });
});

describe("WorkspaceOAuthProvider — user-scoped persistence", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-user-"));
  });

  function userProvider(userId: string, serverName = "test-srv"): WorkspaceOAuthProvider {
    return new WorkspaceOAuthProvider({
      owner: { type: "user", userId },
      serverName,
      workDir,
      callbackUrl: CALLBACK,
    });
  }

  it("rejects malformed user id at construction", () => {
    expect(() => userProvider("../escape")).toThrow(/invalid owner id/);
    expect(() => userProvider("with/slash")).toThrow(/invalid owner id/);
    expect(() => userProvider("..")).toThrow(/invalid owner id/);
    expect(() => userProvider(".")).toThrow(/invalid owner id/);
    expect(() => userProvider("")).toThrow(/invalid owner id/);
    expect(() => userProvider("a".repeat(129))).toThrow(/invalid owner id/);
  });

  it("tokens land under users/<userId>/ — entirely outside the workspaces tree", async () => {
    const a = userProvider("usr_alice", "granola");
    const tokens: OAuthTokens = { access_token: "alice-token", token_type: "Bearer" };
    await a.saveTokens(tokens);

    const userPath = join(
      workDir,
      "users",
      "usr_alice",
      "credentials",
      "mcp-oauth",
      "granola",
      "tokens.json",
    );
    expect(JSON.parse(readFileSync(userPath, "utf-8"))).toEqual(tokens);

    // Per-user tokens MUST NOT live under workspaces/. The whole point of
    // user scope is "not workspace-bound" — leaking a tokens.json into
    // the workspace tree would orphan it on workspace deletion.
    const workspaceLevelPath = join(
      workDir,
      "workspaces",
      "ws_test",
      "credentials",
      "mcp-oauth",
      "granola",
      "tokens.json",
    );
    expect(() => readFileSync(workspaceLevelPath)).toThrow();
  });

  it("two users store tokens independently — neither sees the other's", async () => {
    const a = userProvider("usr_alice", "granola");
    const b = userProvider("usr_bob", "granola");
    await a.saveTokens({ access_token: "alice-token", token_type: "Bearer" });
    await b.saveTokens({ access_token: "bob-token", token_type: "Bearer" });

    // Fresh providers (no in-memory cache) read from disk.
    const a2 = userProvider("usr_alice", "granola");
    const b2 = userProvider("usr_bob", "granola");
    expect((await a2.tokens())?.access_token).toBe("alice-token");
    expect((await b2.tokens())?.access_token).toBe("bob-token");
  });

  it("client.json is per-user — each user's DCR registration is independent", async () => {
    // Each user manages their own OAuth client identity ("Alice's
    // NimbleBrain client", "Bob's NimbleBrain client") rather than
    // sharing a workspace-level registration. This is correct OAuth
    // semantics for personal-scope: my Granola is mine.
    const a = userProvider("usr_alice", "granola");
    const aliceInfo: OAuthClientInformationFull = {
      client_id: "cid-alice",
      redirect_uris: [CALLBACK],
    };
    await a.saveClientInformation(aliceInfo);

    const b = userProvider("usr_bob", "granola");
    const bobInfo: OAuthClientInformationFull = {
      client_id: "cid-bob",
      redirect_uris: [CALLBACK],
    };
    await b.saveClientInformation(bobInfo);

    // Each user's client.json is read back independently.
    const a2 = userProvider("usr_alice", "granola");
    const b2 = userProvider("usr_bob", "granola");
    expect((await a2.clientInformation())?.client_id).toBe("cid-alice");
    expect((await b2.clientInformation())?.client_id).toBe("cid-bob");

    // On disk: each lives under its own user directory.
    const aPath = join(
      workDir,
      "users",
      "usr_alice",
      "credentials",
      "mcp-oauth",
      "granola",
      "client.json",
    );
    expect(JSON.parse(readFileSync(aPath, "utf-8"))).toEqual(aliceInfo);
  });

  it("invalidateCredentials('tokens') only clears the calling user's tokens", async () => {
    const a = userProvider("usr_alice", "granola");
    const b = userProvider("usr_bob", "granola");
    await a.saveTokens({ access_token: "alice-token", token_type: "Bearer" });
    await b.saveTokens({ access_token: "bob-token", token_type: "Bearer" });

    await a.invalidateCredentials("tokens");

    const a2 = userProvider("usr_alice", "granola");
    const b2 = userProvider("usr_bob", "granola");
    expect(await a2.tokens()).toBeUndefined();
    expect((await b2.tokens())?.access_token).toBe("bob-token");
  });

  it("getOwner returns the user-scope owner for user providers", () => {
    expect(userProvider("usr_alice").getOwner()).toEqual({
      type: "user",
      userId: "usr_alice",
    });
    expect(makeProvider(workDir).getOwner()).toEqual({ type: "workspace", wsId: "ws_test" });
  });
});

describe("WorkspaceOAuthProvider — Track A: pre-registered client + scopes + extra params", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-trackA-"));
  });

  it("clientInformation returns the static client when staticClient is set; saveClientInformation is a no-op", async () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "hubspot",
      workDir,
      callbackUrl: CALLBACK,
      staticClient: {
        clientId: "static-cid",
        clientSecret: "static-secret",
        tokenEndpointAuthMethod: "client_secret_post",
      },
    });
    const info = await p.clientInformation();
    expect(info).toMatchObject({
      client_id: "static-cid",
      client_secret: "static-secret",
      redirect_uris: [CALLBACK],
    });

    // Stray DCR-style save MUST NOT overwrite client.json.
    await p.saveClientInformation({
      client_id: "should-not-persist",
      redirect_uris: [CALLBACK],
    });
    const stillStatic = await p.clientInformation();
    expect(stillStatic?.client_id).toBe("static-cid");

    // No client.json on disk either.
    const onDiskPath = join(
      workDir,
      "workspaces",
      "ws_test",
      "credentials",
      "mcp-oauth",
      "hubspot",
      "client.json",
    );
    expect(() => readFileSync(onDiskPath)).toThrow();
  });

  it("clientMetadata.scope reflects the configured scopes (space-joined per RFC 6749)", () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "gmail",
      workDir,
      callbackUrl: CALLBACK,
      scopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.send",
      ],
    });
    expect(p.clientMetadata.scope).toBe(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    );
  });

  it("clientMetadata.client_name uses ownerDisplayName when provided (not the opaque wsId)", () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_user_user_01ABCDEF" },
      ownerDisplayName: "Engineering Team",
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    expect(p.clientMetadata.client_name).toBe("NimbleBrain (Engineering Team)");
  });

  it("clientMetadata.client_name falls back to the raw wsId when no ownerDisplayName", () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_user_user_01ABCDEF" },
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    expect(p.clientMetadata.client_name).toBe("NimbleBrain (ws_user_user_01ABCDEF)");
  });

  it("clientMetadata.client_name uses ownerDisplayName for user-scoped owners too", () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "user", userId: "user_01ABCDEF" },
      ownerDisplayName: "Mat's Workspace",
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    expect(p.clientMetadata.client_name).toBe("NimbleBrain (Mat's Workspace)");
  });

  it("clientMetadata carries NimbleBrain client_uri + logo_uri for consent-screen branding", () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    expect(p.clientMetadata.client_uri).toBe("https://nimblebrain.ai");
    expect(p.clientMetadata.logo_uri).toBe(
      "https://static.nimblebrain.ai/logos/nimblebrain/light-128.png",
    );
  });

  it("clientMetadata default token_endpoint_auth_method = 'none' (DCR PKCE-only) when no staticClient", () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  it("clientMetadata default token_endpoint_auth_method = 'client_secret_post' when secret provided without override", () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "hubspot",
      workDir,
      callbackUrl: CALLBACK,
      staticClient: { clientId: "c", clientSecret: "s" },
    });
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");
  });

  it("explicit tokenEndpointAuthMethod override wins", () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "weird-vendor",
      workDir,
      callbackUrl: CALLBACK,
      staticClient: {
        clientId: "c",
        clientSecret: "s",
        tokenEndpointAuthMethod: "client_secret_basic",
      },
    });
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("client_secret_basic");
  });

  it("constructor rejects reserved keys in additionalAuthorizationParams", () => {
    const make = (extras: Record<string, string>) =>
      () =>
        new WorkspaceOAuthProvider({
          owner: { type: "workspace", wsId: "ws_test" },
          serverName: "broken",
          workDir,
          callbackUrl: CALLBACK,
          additionalAuthorizationParams: extras,
        });

    expect(make({ client_id: "evil" })).toThrow(/reserved keys/);
    expect(make({ state: "no" })).toThrow(/reserved keys/);
    expect(make({ scope: "more" })).toThrow(/reserved keys/);
    expect(make({ code_challenge: "bypass" })).toThrow(/reserved keys/);
  });

  it("redirectToAuthorization appends additionalAuthorizationParams to the authorize URL", async () => {
    // Use a Bun-served mock to verify the URL the provider tries to fetch.
    // Test asserts the built URL by inspecting the deferred-thrown
    // UnauthorizedError's message, which carries `url.origin`. For full
    // URL-shape verification we use a different angle: spy on fetch by
    // wrapping global fetch via a closure-captured array. To keep the
    // test simple and avoid Bun.serve, we just construct the URL the
    // SDK would build and call redirectToAuthorization directly with a
    // controlled `state`, then read the URL back from the captured
    // fetch call's URL parameter.
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push(u);
      // Force the headless probe to fail (200 response with no Location)
      // so the provider falls through to the interactive branch.
      return new Response("not a redirect", { status: 200 });
    }) as typeof fetch;
    try {
      const p = new WorkspaceOAuthProvider({
        owner: { type: "workspace", wsId: "ws_test" },
        serverName: "google",
        workDir,
        callbackUrl: CALLBACK,
        allowInsecureRemotes: true,
        // This test inspects the URL the probe's fetch sees, so enable the probe.
        headlessAuthProbe: true,
        additionalAuthorizationParams: {
          access_type: "offline",
          prompt: "consent",
        },
      });
      const state = p.state();
      const authUrl = new URL("http://localhost:39991/oauth/authorize");
      authUrl.searchParams.set("state", state);
      try {
        await p.redirectToAuthorization(authUrl);
      } catch {
        // expected — UnauthorizedError on interactive branch
      }
      // The URL passed to fetch (after our params were appended) should
      // contain access_type and prompt.
      const fetched = calls[0] ?? "";
      expect(fetched).toContain("access_type=offline");
      expect(fetched).toContain("prompt=consent");
      expect(fetched).toContain(`state=${state}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("WorkspaceOAuthProvider — revokeAndDeleteTokens", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-rev-"));
  });

  /** Build a fake fetch that records calls + returns programmable responses. */
  function makeFetcher(
    responses: Record<string, { status: number; body?: unknown }>,
  ): { fetch: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      calls.push({ url: u, init });
      const r = responses[u];
      if (!r) return new Response(null, { status: 404 });
      const body = r.body !== undefined ? JSON.stringify(r.body) : null;
      return new Response(body, {
        status: r.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { fetch: fetcher, calls };
  }

  it("returns no-op result when no tokens are stored", async () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    const { fetch: f, calls } = makeFetcher({});
    const result = await p.revokeAndDeleteTokens({
      bundleUrl: "https://mcp.granola.test/mcp",
      fetchImpl: f,
    });
    expect(result.deletedLocal).toBe(true);
    expect(result.revoked).toEqual({});
    // No revocation discovery attempted when there are no tokens.
    expect(calls.length).toBe(0);
  });

  it("revokes refresh + access via discovered endpoint, then deletes locally", async () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
      allowInsecureRemotes: true,
    });
    await p.saveClientInformation({ client_id: "test-client", redirect_uris: [CALLBACK] });
    await p.saveTokens({
      access_token: "acc-tok",
      token_type: "Bearer",
      refresh_token: "ref-tok",
    });

    const bundleUrl = "http://localhost:39990/mcp";
    const { fetch: f, calls } = makeFetcher({
      "http://localhost:39990/.well-known/oauth-authorization-server": {
        status: 200,
        body: {
          revocation_endpoint: "http://localhost:39990/oauth/revoke",
        },
      },
      "http://localhost:39990/oauth/revoke": { status: 200 },
    });

    const result = await p.revokeAndDeleteTokens({ bundleUrl, fetchImpl: f });
    expect(result.deletedLocal).toBe(true);
    expect(result.revoked.refresh).toBe(true);
    expect(result.revoked.access).toBe(true);
    // Discovery probes RFC 9728 (/.well-known/oauth-protected-resource —
    // not in fake → 404) then RFC 8414 fallback (/.well-known/oauth-
    // authorization-server — in fake), then 2 revoke calls = 4 total.
    expect(calls.length).toBe(4);

    // Both revoke calls are POSTs with x-www-form-urlencoded
    const revokeCalls = calls.filter((c) => c.url.endsWith("/oauth/revoke"));
    expect(revokeCalls.length).toBe(2);
    for (const r of revokeCalls) {
      expect(r.init?.method).toBe("POST");
      const headers = r.init?.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      expect(String(r.init?.body)).toContain("client_id=test-client");
    }

    // Verify local files are gone.
    const p2 = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    expect(await p2.tokens()).toBeUndefined();
  });

  it("deletes local tokens even when revocation endpoint discovery fails", async () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
      allowInsecureRemotes: true,
    });
    await p.saveClientInformation({ client_id: "test-client", redirect_uris: [CALLBACK] });
    await p.saveTokens({ access_token: "acc-tok", token_type: "Bearer" });

    // Metadata endpoint 404s → no revocation_endpoint → skip revoke, still delete locally.
    const { fetch: f } = makeFetcher({});
    const result = await p.revokeAndDeleteTokens({
      bundleUrl: "http://localhost:39990/mcp",
      fetchImpl: f,
    });
    expect(result.deletedLocal).toBe(true);
    expect(result.revoked).toEqual({});

    const p2 = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    expect(await p2.tokens()).toBeUndefined();
    // Disconnect MUST also drop the cached DCR client info — leaving
    // it behind across a NB_API_URL change is the canonical
    // `Invalid redirect_uri for OAuth client` foot-gun.
    expect(await p2.clientInformation()).toBeUndefined();
  });

  it("captures OIDC id_token claims to identity.json on saveTokens", async () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "google",
      workDir,
      callbackUrl: CALLBACK,
    });
    // Build a fake JWT — the parser only cares about the payload segment.
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/=/g, "");
    const payload = btoa(
      JSON.stringify({
        sub: "1234567890",
        email: "mat@nimblebrain.ai",
        name: "Mat Goldsborough",
        iss: "https://accounts.google.com",
        aud: "test-client",
      }),
    ).replace(/=/g, "");
    const fakeIdToken = `${header}.${payload}.fakesig`;

    await p.saveTokens({
      access_token: "acc",
      token_type: "Bearer",
      // biome-ignore lint/suspicious/noExplicitAny: id_token is an OIDC extension on OAuthTokens
      id_token: fakeIdToken,
    } as any);

    const identity = await p.identity();
    expect(identity).toEqual({
      sub: "1234567890",
      email: "mat@nimblebrain.ai",
      name: "Mat Goldsborough",
    });
  });

  it("identity() returns null when no id_token was issued", async () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "no-oidc",
      workDir,
      callbackUrl: CALLBACK,
    });
    await p.saveTokens({ access_token: "acc", token_type: "Bearer" });
    expect(await p.identity()).toBeNull();
  });

  it("invalidateCredentials('tokens') also removes identity.json", async () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "google",
      workDir,
      callbackUrl: CALLBACK,
    });
    const header = btoa(JSON.stringify({ alg: "RS256" })).replace(/=/g, "");
    const payload = btoa(JSON.stringify({ sub: "x", email: "x@y.z" })).replace(/=/g, "");
    await p.saveTokens({
      access_token: "a",
      token_type: "Bearer",
      // biome-ignore lint/suspicious/noExplicitAny: id_token extension
      id_token: `${header}.${payload}.s`,
    } as any);
    expect(await p.identity()).not.toBeNull();
    await p.invalidateCredentials("tokens");
    expect(await p.identity()).toBeNull();
  });

  it("malformed id_token does not break saveTokens", async () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "broken",
      workDir,
      callbackUrl: CALLBACK,
    });
    // Not enough segments → parser returns null, identity not written, no throw.
    await p.saveTokens({
      access_token: "a",
      token_type: "Bearer",
      // biome-ignore lint/suspicious/noExplicitAny: malformed id_token
      id_token: "not.a.jwt.at.all",
    } as any);
    expect(await p.identity()).toBeNull();
    expect((await p.tokens())?.access_token).toBe("a");
  });

  it("RFC 9728: discovers AS at a different origin via oauth-protected-resource", async () => {
    // Mimics Google: bundle at gmailmcp.googleapis.com but AS at
    // oauth2.googleapis.com. The protected-resource metadata points at
    // the AS origin; we then fetch the AS's authorization-server metadata
    // for the revocation_endpoint.
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "gmail",
      workDir,
      callbackUrl: CALLBACK,
      allowInsecureRemotes: true,
    });
    await p.saveClientInformation({ client_id: "g-client", redirect_uris: [CALLBACK] });
    await p.saveTokens({
      access_token: "g-access",
      token_type: "Bearer",
      refresh_token: "g-refresh",
    });

    // Bundle origin: localhost:39990. AS origin: localhost:39991.
    const bundleUrl = "http://localhost:39990/mcp/v1";
    const { fetch: f, calls } = makeFetcher({
      "http://localhost:39990/.well-known/oauth-protected-resource": {
        status: 200,
        body: { authorization_servers: ["http://localhost:39991/"] },
      },
      "http://localhost:39991/.well-known/oauth-authorization-server": {
        status: 200,
        body: { revocation_endpoint: "http://localhost:39991/oauth/revoke" },
      },
      "http://localhost:39991/oauth/revoke": { status: 200 },
    });

    const result = await p.revokeAndDeleteTokens({ bundleUrl, fetchImpl: f });
    expect(result.revoked.refresh).toBe(true);
    expect(result.revoked.access).toBe(true);
    // 1 PR metadata + 1 AS metadata + 2 revoke = 4 calls.
    expect(calls.length).toBe(4);
    // Revocation hit the OTHER origin, not the bundle origin.
    expect(calls.some((c) => c.url === "http://localhost:39991/oauth/revoke")).toBe(true);
  });

  it("treats RFC 7009 invalid_token 400 as success", async () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
      allowInsecureRemotes: true,
    });
    await p.saveClientInformation({ client_id: "c1", redirect_uris: [CALLBACK] });
    await p.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r" });

    const { fetch: f } = makeFetcher({
      "http://localhost:39990/.well-known/oauth-authorization-server": {
        status: 200,
        body: { revocation_endpoint: "http://localhost:39990/oauth/revoke" },
      },
      "http://localhost:39990/oauth/revoke": {
        status: 400,
        body: { error: "invalid_token" },
      },
    });
    const result = await p.revokeAndDeleteTokens({
      bundleUrl: "http://localhost:39990/mcp",
      fetchImpl: f,
    });
    expect(result.revoked.refresh).toBe(true);
    expect(result.revoked.access).toBe(true);
    expect(result.deletedLocal).toBe(true);
  });
});

describe("WorkspaceOAuthProvider — WorkspaceContext construction (Stage 0)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-ctx-test-"));
  });

  it("derives the same dataDir whether constructed via workDir alone or workspaceContext", async () => {
    const ctx = new WorkspaceContext({ wsId: "ws_test", workDir });
    const viaLegacy = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    const viaContext = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
      workspaceContext: ctx,
    });
    // Functional check: write through one, read through the other. If the
    // two constructors agree on dataDir they'll see each other's files.
    await viaLegacy.saveTokens({ access_token: "a", token_type: "Bearer", refresh_token: "r" });
    const seenByContext = await viaContext.tokens();
    expect(seenByContext).toEqual({
      access_token: "a",
      token_type: "Bearer",
      refresh_token: "r",
    });
  });

  it("rejects a workspaceContext whose wsId does not match the owner", () => {
    const ctx = new WorkspaceContext({ wsId: "ws_other", workDir });
    expect(
      () =>
        new WorkspaceOAuthProvider({
          owner: { type: "workspace", wsId: "ws_test" },
          serverName: "granola",
          workDir,
          callbackUrl: CALLBACK,
          workspaceContext: ctx,
        }),
    ).toThrow(/owner\/context mismatch/);
  });

  it("rejects a workspaceContext paired with a user-typed owner", () => {
    const ctx = new WorkspaceContext({ wsId: "ws_test", workDir });
    expect(
      () =>
        new WorkspaceOAuthProvider({
          owner: { type: "user", userId: "user_alice" },
          serverName: "granola",
          workDir,
          callbackUrl: CALLBACK,
          workspaceContext: ctx,
        }),
    ).toThrow(/workspaceContext is only valid with workspace-typed owners/);
  });

  it("returns the same owner instance via getOwner — no rebind path", () => {
    const owner = { type: "workspace" as const, wsId: "ws_test" };
    const p = new WorkspaceOAuthProvider({
      owner,
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    // The owner-context type is readonly, so attempted reassignment is a
    // compile error. Verify at runtime that the wsId still matches and is
    // structurally identical to the construction-time value.
    expect(p.getOwner()).toEqual(owner);
  });
});

describe("WorkspaceOAuthProvider — notifyAuthLost (mid-session auth loss)", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-authlost-"));
  });

  const TOKENS: OAuthTokens = { access_token: "a", token_type: "bearer" };

  it("fires onAuthLost once even when called repeatedly (de-dupes a burst)", () => {
    let calls = 0;
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "teams",
      workDir,
      callbackUrl: CALLBACK,
      onAuthLost: () => {
        calls++;
      },
    });

    p.notifyAuthLost();
    p.notifyAuthLost();
    p.notifyAuthLost();

    expect(calls).toBe(1);
  });

  it("re-arms after saveTokens so a later auth loss signals again", async () => {
    let calls = 0;
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "teams",
      workDir,
      callbackUrl: CALLBACK,
      onAuthLost: () => {
        calls++;
      },
    });

    p.notifyAuthLost();
    expect(calls).toBe(1);

    // Successful reconnect persists fresh tokens → next loss is a new episode.
    await p.saveTokens(TOKENS);
    p.notifyAuthLost();
    expect(calls).toBe(2);
  });

  it("is a no-op (no throw) when no onAuthLost callback is wired", () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "teams",
      workDir,
      callbackUrl: CALLBACK,
    });
    expect(() => p.notifyAuthLost()).not.toThrow();
  });

  it("swallows a throwing onAuthLost callback (never worsens a tool-call failure)", () => {
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "teams",
      workDir,
      callbackUrl: CALLBACK,
      onAuthLost: () => {
        throw new Error("boom");
      },
    });
    expect(() => p.notifyAuthLost()).not.toThrow();
  });
});

describe("WorkspaceOAuthProvider — redacted OAuth health logging", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-health-"));
  });

  it("warns when a token exchange returns NO refresh_token (the non-refreshable connector)", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const p = makeProvider(workDir, "com-dropbox-mcp");
      await p.saveTokens({
        access_token: "sl.SECRET_ACCESS_VALUE",
        token_type: "bearer",
        expires_in: 14400,
      });

      const msgs = warn.mock.calls.map((c) => String(c[0]));
      const hit = msgs.find((m) => m.includes("com-dropbox-mcp") && /no refresh_token/i.test(m));
      expect(hit).toBeDefined();
      // Redaction invariant: a token VALUE must never reach the logs.
      for (const m of msgs) expect(m).not.toContain("sl.SECRET_ACCESS_VALUE");
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT warn when a refresh_token is present, and never logs token values", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const p = makeProvider(workDir, "com-notion-mcp");
      await p.saveTokens({
        access_token: "ACCESS_SECRET_VALUE",
        token_type: "bearer",
        refresh_token: "REFRESH_SECRET_VALUE",
        expires_in: 3600,
      });

      const msgs = warn.mock.calls.map((c) => String(c[0]));
      expect(msgs.some((m) => /no refresh_token/i.test(m))).toBe(false);
      for (const m of msgs) {
        expect(m).not.toContain("ACCESS_SECRET_VALUE");
        expect(m).not.toContain("REFRESH_SECRET_VALUE");
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("notifyAuthLost emits a redacted reauth warn naming the connector", async () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      const p = makeProvider(workDir, "com-dropbox-mcp");
      p.notifyAuthLost();
      const msgs = warn.mock.calls.map((c) => String(c[0]));
      expect(
        msgs.some((m) => m.includes("com-dropbox-mcp") && /reauth_required/.test(m)),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
