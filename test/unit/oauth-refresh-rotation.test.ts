import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/client";
import type { FetchLike } from "@modelcontextprotocol/server";
import {
  createOAuthRefreshFetch,
  resetRefreshExchanges,
} from "../../src/tools/oauth-refresh-fetch.ts";
import { createSsrfGuardedFetch } from "../../src/tools/ssrf-guarded-fetch.ts";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

/**
 * A vendor that rotates refresh tokens issues a new one on every refresh and
 * revokes the one it was given. A refresh token is then a single-use
 * credential, and any request that spends one already spent gets
 * `invalid_grant`. The runtime must not let that second spend delete a
 * credential that is still good: the SDK answers `invalid_grant` by deleting
 * the stored tokens, and the connection then needs a person to reconnect it.
 *
 * These drive the SDK's own `auth()` against a fake rotating authorization
 * server, through real `WorkspaceOAuthProvider` instances sharing one
 * credential store, the way two transports or two providers for one
 * connection do in the runtime.
 */

const WS = "ws_0076759dbbe19fcc";
const SERVER = "rotating-srv";
const MCP_URL = "https://mcp.rotating.example/mcp";
const ISSUER = "https://auth.rotating.example";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";

/** The vendor: discovery documents, and a token endpoint that rotates. */
function rotatingServer() {
  let current = "rt_1";
  let issued = 1;
  const spent: string[] = [];
  let refreshPosts = 0;
  let gate: Promise<void> | null = null;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json({ resource: MCP_URL, authorization_servers: [ISSUER] });
    }
    if (
      url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
      url.pathname.startsWith("/.well-known/openid-configuration")
    ) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/oauth/authorize`,
        token_endpoint: TOKEN_URL,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.href === TOKEN_URL) {
      refreshPosts++;
      const raw = init?.body;
      const body = new URLSearchParams(
        ArrayBuffer.isView(raw) ? new TextDecoder().decode(raw) : String(raw ?? ""),
      );
      const presented = body.get("refresh_token") ?? "";
      if (gate) await gate;
      if (presented !== current) return json({ error: "invalid_grant" }, 400);
      spent.push(presented);
      current = `rt_${++issued}`;
      return json({
        access_token: `at_${issued}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: current,
      });
    }
    return new Response("not found", { status: 404 });
  };

  return {
    fetchImpl,
    current: () => current,
    refreshPosts: () => refreshPosts,
    /** Hold token responses until `release()`, so two POSTs overlap. */
    hold(): () => void {
      let release!: () => void;
      gate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        gate = null;
        release();
      };
    },
  };
}

function makeProvider(): WorkspaceOAuthProvider {
  return new WorkspaceOAuthProvider({
    owner: { type: "workspace", wsId: WS },
    serverName: SERVER,
    callbackUrl: CALLBACK,
  });
}

/** One transport's view: the SDK's `auth()` through that transport's refresh fetch. */
function refreshVia(provider: WorkspaceOAuthProvider, fetchFn: FetchLike) {
  return auth(provider, { serverUrl: MCP_URL, fetchFn });
}

const fast = { sleep: (_ms: number) => Promise.resolve(), rng: () => 0 } as const;

async function seedConnection(): Promise<void> {
  const p = makeProvider();
  await p.saveClientInformation({ client_id: "client-1", redirect_uris: [CALLBACK] });
  await p.saveTokens({
    access_token: "at_1",
    token_type: "Bearer",
    refresh_token: "rt_1",
    issuer: ISSUER,
  } as Parameters<WorkspaceOAuthProvider["saveTokens"]>[0]);
}

async function storedRefreshToken(): Promise<string | undefined> {
  return (await makeProvider().tokens())?.refresh_token;
}

describe("refresh under rotation never deletes a credential that is still good", () => {
  beforeEach(() => {
    const workDir = mkdtempSync(join(tmpdir(), "nb-oauth-rotation-"));
    seedWorkspaceRoot(workDir, WS);
    installTestCredentialStore(workDir);
    resetRefreshExchanges();
  });
  afterEach(() => {
    resetTestCredentialStore();
  });

  it("test_refresh_stale_provider_cache_keeps_rotated_tokens", async () => {
    const vendor = rotatingServer();
    await seedConnection();
    // Two providers for one connection, both holding rt_1 in cache.
    const a = makeProvider();
    const b = makeProvider();
    await a.tokens();
    await b.tokens();

    expect(
      await refreshVia(a, createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast })),
    ).toBe("AUTHORIZED");
    expect(await storedRefreshToken()).toBe(vendor.current());

    // `b` still caches the spent rt_1. Its refresh must not cost the connection.
    const result = await refreshVia(
      b,
      createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast }),
    ).catch((err: unknown) => err);
    expect(result).toBe("AUTHORIZED");
    expect(await storedRefreshToken()).toBe(vendor.current());
  });

  it("test_refresh_two_transports_same_token_one_exchange", async () => {
    const vendor = rotatingServer();
    await seedConnection();
    const provider = makeProvider();
    const release = vendor.hold();
    // Two transports on one provider: each has its own refresh fetch.
    const first = refreshVia(
      provider,
      createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast }),
    );
    const second = refreshVia(
      provider,
      createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast }),
    );
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all([first, second].map((p) => p.catch((err: unknown) => err)));
    expect(results).toEqual(["AUTHORIZED", "AUTHORIZED"]);
    expect(await storedRefreshToken()).toBe(vendor.current());
  });

  it("test_refresh_stale_copy_after_replay_window_keeps_stored_tokens", async () => {
    const vendor = rotatingServer();
    await seedConnection();
    const a = makeProvider();
    const b = makeProvider();
    await b.tokens(); // b reads rt_1 and keeps it
    await refreshVia(a, createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast }));

    resetRefreshExchanges(); // hours later: no exchange answers for rt_1 any more

    // b spends rt_1, the vendor rejects it, and the store holds a newer token.
    const result = await refreshVia(
      b,
      createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast }),
    ).catch((err: unknown) => err);
    expect(result).toBe("AUTHORIZED");
    expect(await storedRefreshToken()).toBe(vendor.current());
  });

  it("test_refresh_through_ssrf_guard_parallel_spends_one_exchange", async () => {
    // The transport's chain: the SSRF guard outside the refresh fetch
    // (`createRemoteTransport`). The guard buffers the SDK's form body to
    // bytes before the refresh fetch sees it.
    const vendor = rotatingServer();
    await seedConnection();
    const provider = makeProvider();
    const chain = () =>
      createSsrfGuardedFetch(createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast }), {
        allowInsecure: false,
        fleetInternal: false,
      });
    const release = vendor.hold();
    const transport = chain();
    const calls = [1, 2, 3].map(() => refreshVia(provider, transport));
    await new Promise((r) => setTimeout(r, 20));
    release();
    const results = await Promise.all(calls.map((p) => p.catch((err: unknown) => err)));
    expect(results).toEqual(["AUTHORIZED", "AUTHORIZED", "AUTHORIZED"]);
    expect(vendor.refreshPosts()).toBe(1);
    expect(await storedRefreshToken()).toBe(vendor.current());
  });

  it("test_refresh_dead_credential_still_flips_to_reauth", async () => {
    const vendor = rotatingServer();
    await seedConnection();
    const p = makeProvider();
    await p.saveTokens({
      access_token: "at_x",
      token_type: "Bearer",
      refresh_token: "rt_revoked_by_vendor",
      issuer: ISSUER,
    } as Parameters<WorkspaceOAuthProvider["saveTokens"]>[0]);
    const result = await refreshVia(
      p,
      createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast }),
    ).catch((err: unknown) => err);
    expect(result).not.toBe("AUTHORIZED");
    expect(await storedRefreshToken()).toBeUndefined();
  });
});
