import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auth } from "@modelcontextprotocol/client";
import type { FetchLike } from "@modelcontextprotocol/server";
import { log } from "../../src/observability/log.ts";
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
/** `refusalStatus` is the HTTP status the vendor answers `invalid_grant` with. */
function rotatingServer(refusalStatus = 400) {
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
      if (presented !== current) return json({ error: "invalid_grant" }, refusalStatus);
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

/**
 * A transport fetch that, once its first token POST has its response and before
 * the SDK reads it, runs `meanwhile`: what another flow on the same provider does
 * while an exchange is in flight.
 */
function interleaveAfterTokenPost(inner: FetchLike, meanwhile: () => Promise<void>): FetchLike {
  let ran = false;
  return async (url, init) => {
    const res = await inner(url, init);
    if (!ran && String(url) === TOKEN_URL) {
      ran = true;
      await meanwhile();
    }
    return res;
  };
}

/** Another flow on `provider` lands the stored tokens, then a request's bearer read serves them. */
async function bearerReadOfStoredTokens(
  provider: WorkspaceOAuthProvider,
): Promise<string | undefined> {
  const stored = await makeProvider().tokens();
  if (stored) await provider.saveTokens(stored);
  return (await provider.tokens())?.refresh_token;
}

/** The tag a log line names a refresh token by: the first 8 hex of its sha256. */
function tag(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex").slice(0, 8);
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

  it("test_refresh_overlapping_saves_keep_the_newest_rotation", async () => {
    // One provider saves rt_2 (spent rt_1) and, before that write lands, rt_3
    // (spent rt_2, read from the cache the first save set). The second save's
    // stale check must see the first's write, or it drops rt_3 and the store
    // ends on rt_2, which the vendor has revoked.
    const vendor = rotatingServer();
    await seedConnection();
    const fetchFn = createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast });
    const exchange = async (refreshToken: string) => {
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      const res = await fetchFn(TOKEN_URL, { method: "POST", body });
      const issued = (await res.json()) as { access_token: string; refresh_token: string };
      return { ...issued, token_type: "Bearer" };
    };
    const second = await exchange("rt_1");
    const third = await exchange("rt_2");
    const provider = makeProvider();

    await Promise.all([provider.saveTokens(second), provider.saveTokens(third)]);

    expect(vendor.current()).toBe("rt_3");
    expect(await storedRefreshToken()).toBe("rt_3");
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

  it("test_refresh_replayed_result_never_rolls_back_newer_tokens", async () => {
    // rt_1 → rt_2 → rt_3 inside the replay window, then a provider still
    // holding rt_1 refreshes: the replayed rt_1 exchange answers with rt_2.
    const vendor = rotatingServer();
    await seedConnection();
    const a = makeProvider();
    const stale = makeProvider();
    await stale.tokens(); // holds rt_1
    const fetchFn = createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast });
    expect(await refreshVia(a, fetchFn)).toBe("AUTHORIZED");
    expect(await refreshVia(a, fetchFn)).toBe("AUTHORIZED");
    expect(vendor.current()).toBe("rt_3");

    const result = await refreshVia(stale, fetchFn).catch((err: unknown) => err);
    expect(result).toBe("AUTHORIZED");
    expect(vendor.refreshPosts()).toBe(2);
    expect(await storedRefreshToken()).toBe("rt_3");
    expect((await stale.tokens())?.refresh_token).toBe("rt_3");
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

  it("test_refresh_bearer_read_of_newer_token_mid_stale_exchange_keeps_newer_tokens", async () => {
    // The replayed rt_1 exchange answers with rt_2 while the store holds rt_3,
    // and between the spend and its result the provider's bearer read serves
    // rt_3. The result still answers for rt_1, so it must not overwrite rt_3.
    const vendor = rotatingServer();
    await seedConnection();
    const a = makeProvider();
    const stale = makeProvider();
    await stale.tokens(); // holds rt_1
    const fetchFn = createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast });
    await refreshVia(a, fetchFn);
    await refreshVia(a, fetchFn);
    expect(vendor.current()).toBe("rt_3");

    let servedMidExchange: string | undefined;
    const result = await refreshVia(
      stale,
      interleaveAfterTokenPost(fetchFn, async () => {
        servedMidExchange = await bearerReadOfStoredTokens(stale);
      }),
    ).catch((err: unknown) => err);
    expect(servedMidExchange).toBe("rt_3");
    expect(result).toBe("AUTHORIZED");
    expect(await storedRefreshToken()).toBe("rt_3");
  });

  // A vendor may answer `invalid_grant` on a 4xx other than RFC 6749's 400; the
  // refusal record follows the retry policy's classification either way.
  for (const [suffix, refusalStatus] of [
    ["", 400],
    ["_on_http_422", 422],
  ] as const) {
    it(`test_refresh_bearer_read_of_newer_token_mid_rejected_exchange_keeps_newer_tokens${suffix}`, async () => {
      // The vendor refuses the spent rt_1 while the store holds rt_2, and between
      // the spend and the refusal the provider's bearer read serves rt_2. The
      // refusal is for rt_1, so it must not delete rt_2.
      const info = spyOn(log, "info").mockImplementation(() => {});
      try {
        const vendor = rotatingServer(refusalStatus);
        await seedConnection();
        const a = makeProvider();
        const stale = makeProvider();
        await stale.tokens(); // holds rt_1
        await refreshVia(a, createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast }));
        resetRefreshExchanges(); // past the replay window: rt_1 is spent at the vendor

        let servedMidExchange: string | undefined;
        const result = await refreshVia(
          stale,
          interleaveAfterTokenPost(
            createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast }),
            async () => {
              servedMidExchange = await bearerReadOfStoredTokens(stale);
            },
          ),
        ).catch((err: unknown) => err);
        expect(servedMidExchange).toBe("rt_2");
        expect(result).toBe("AUTHORIZED");
        expect(await storedRefreshToken()).toBe(vendor.current());
        const fields = info.mock.calls.map(([, f]) => (f ?? {}) as Record<string, unknown>);
        expect(fields).toContainEqual(
          expect.objectContaining({
            connector: SERVER,
            outcome: "kept-stored",
            error: "invalid_grant",
            spent_refresh_hash: tag("rt_1"),
            stored_refresh_hash: tag("rt_2"),
          }),
        );
      } finally {
        info.mockRestore();
      }
    });
  }

  it("test_refresh_outcome_logs_carry_hash_tags_never_token_values", async () => {
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
      const vendor = rotatingServer();
      await seedConnection();
      const a = makeProvider();
      const stale = makeProvider();
      await stale.tokens(); // holds rt_1
      const fetchFn = createOAuthRefreshFetch({ fetchImpl: vendor.fetchImpl, ...fast });
      await refreshVia(a, fetchFn);
      await refreshVia(a, fetchFn);
      await refreshVia(stale, fetchFn); // replayed rt_1 exchange, result dropped

      const fields = info.mock.calls.map(([, f]) => (f ?? {}) as Record<string, unknown>);
      expect(fields).toContainEqual(
        expect.objectContaining({
          connector: SERVER,
          owner_type: "workspace",
          owner_id: WS,
          outcome: "saved",
          spent_refresh_hash: tag("rt_1"),
          received_refresh_hash: tag("rt_2"),
        }),
      );
      expect(fields).toContainEqual({ spent_refresh_hash: tag("rt_1"), shared: "replay" });
      expect(fields).toContainEqual(
        expect.objectContaining({
          connector: SERVER,
          outcome: "dropped-stale",
          spent_refresh_hash: tag("rt_1"),
          received_refresh_hash: tag("rt_2"),
          stored_refresh_hash: tag("rt_3"),
        }),
      );
      const logged = JSON.stringify(info.mock.calls);
      for (const secret of ["rt_1", "rt_2", "rt_3", "at_2", "at_3"]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      info.mockRestore();
    }
  });

  it("test_refresh_dead_credential_still_flips_to_reauth", async () => {
    const info = spyOn(log, "info").mockImplementation(() => {});
    try {
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
      const fields = info.mock.calls.map(([, f]) => (f ?? {}) as Record<string, unknown>);
      expect(fields).toContainEqual(
        expect.objectContaining({
          connector: SERVER,
          outcome: "invalidated",
          error: "invalid_grant",
          stored_refresh_hash: tag("rt_revoked_by_vendor"),
        }),
      );
    } finally {
      info.mockRestore();
    }
  });
});
