import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";

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
    wsId: "ws_test",
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

describe("WorkspaceOAuthProvider — member-scoped persistence", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-mem-"));
  });

  function memberProvider(memberId: string, serverName = "test-srv"): WorkspaceOAuthProvider {
    return new WorkspaceOAuthProvider({
      wsId: "ws_test",
      serverName,
      workDir,
      callbackUrl: CALLBACK,
      memberId,
    });
  }

  it("rejects malformed memberId at construction", () => {
    expect(() => memberProvider("../escape")).toThrow(/invalid memberId/);
    expect(() => memberProvider("with/slash")).toThrow(/invalid memberId/);
    expect(() => memberProvider("..")).toThrow(/invalid memberId/);
    expect(() => memberProvider(".")).toThrow(/invalid memberId/);
    expect(() => memberProvider("")).toThrow(/invalid memberId/);
    expect(() => memberProvider("a".repeat(129))).toThrow(/invalid memberId/);
  });

  it("tokens land under members/<memberId>/ — never at workspace root", async () => {
    const a = memberProvider("usr_alice", "granola");
    const tokens: OAuthTokens = { access_token: "alice-token", token_type: "Bearer" };
    await a.saveTokens(tokens);

    const memberPath = join(
      workDir,
      "workspaces",
      "ws_test",
      "credentials",
      "mcp-oauth",
      "granola",
      "members",
      "usr_alice",
      "tokens.json",
    );
    expect(JSON.parse(readFileSync(memberPath, "utf-8"))).toEqual(tokens);

    // Workspace-level tokens.json must NOT exist (no leakage to shared dir).
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

  it("two members store tokens independently — neither sees the other's", async () => {
    const a = memberProvider("usr_alice", "granola");
    const b = memberProvider("usr_bob", "granola");
    await a.saveTokens({ access_token: "alice-token", token_type: "Bearer" });
    await b.saveTokens({ access_token: "bob-token", token_type: "Bearer" });

    // Fresh providers (no in-memory cache) read from disk.
    const a2 = memberProvider("usr_alice", "granola");
    const b2 = memberProvider("usr_bob", "granola");
    expect((await a2.tokens())?.access_token).toBe("alice-token");
    expect((await b2.tokens())?.access_token).toBe("bob-token");
  });

  it("client.json is workspace-shared even when tokens are per-member", async () => {
    // Member A saves DCR client info — should land at the workspace level
    // (NimbleBrain registers as one client per workspace, regardless of
    // which member happened to trigger DCR first).
    const a = memberProvider("usr_alice", "granola");
    const info: OAuthClientInformationFull = { client_id: "cid-shared", redirect_uris: [CALLBACK] };
    await a.saveClientInformation(info);

    // Member B (different memberId) reads the same client.json.
    const b = memberProvider("usr_bob", "granola");
    expect(await b.clientInformation()).toEqual(info);

    // And on disk, client.json is at the workspace level (no /members/ segment).
    const workspaceClientPath = join(
      workDir,
      "workspaces",
      "ws_test",
      "credentials",
      "mcp-oauth",
      "granola",
      "client.json",
    );
    expect(JSON.parse(readFileSync(workspaceClientPath, "utf-8"))).toEqual(info);
  });

  it("invalidateCredentials('tokens') only clears the calling member's tokens", async () => {
    const a = memberProvider("usr_alice", "granola");
    const b = memberProvider("usr_bob", "granola");
    await a.saveTokens({ access_token: "alice-token", token_type: "Bearer" });
    await b.saveTokens({ access_token: "bob-token", token_type: "Bearer" });

    await a.invalidateCredentials("tokens");

    const a2 = memberProvider("usr_alice", "granola");
    const b2 = memberProvider("usr_bob", "granola");
    expect(await a2.tokens()).toBeUndefined();
    expect((await b2.tokens())?.access_token).toBe("bob-token");
  });

  it("getMemberId returns memberId for member-scope and undefined for workspace-scope", () => {
    expect(memberProvider("usr_alice").getMemberId()).toBe("usr_alice");
    expect(makeProvider(workDir).getMemberId()).toBeUndefined();
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
      wsId: "ws_test",
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
      wsId: "ws_test",
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
    expect(calls.length).toBe(3); // metadata + 2 revoke calls

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
      wsId: "ws_test",
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    expect(await p2.tokens()).toBeUndefined();
  });

  it("deletes local tokens even when revocation endpoint discovery fails", async () => {
    const p = new WorkspaceOAuthProvider({
      wsId: "ws_test",
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
      wsId: "ws_test",
      serverName: "granola",
      workDir,
      callbackUrl: CALLBACK,
    });
    expect(await p2.tokens()).toBeUndefined();
  });

  it("captures OIDC id_token claims to identity.json on saveTokens", async () => {
    const p = new WorkspaceOAuthProvider({
      wsId: "ws_test",
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
      wsId: "ws_test",
      serverName: "no-oidc",
      workDir,
      callbackUrl: CALLBACK,
    });
    await p.saveTokens({ access_token: "acc", token_type: "Bearer" });
    expect(await p.identity()).toBeNull();
  });

  it("invalidateCredentials('tokens') also removes identity.json", async () => {
    const p = new WorkspaceOAuthProvider({
      wsId: "ws_test",
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
      wsId: "ws_test",
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

  it("treats RFC 7009 invalid_token 400 as success", async () => {
    const p = new WorkspaceOAuthProvider({
      wsId: "ws_test",
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
