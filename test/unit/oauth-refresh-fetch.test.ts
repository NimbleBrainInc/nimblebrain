import { describe, expect, it } from "bun:test";
import { createOAuthRefreshFetch } from "../../src/tools/oauth-refresh-fetch.ts";

// The OAuth refresh-fetch wrapper restores the truth of McpSource's contract:
// a tool call throwing UnauthorizedError should mean the refresh token was
// genuinely rejected. It does that by absorbing TRANSIENT token-endpoint
// refresh failures (network throw, 5xx, 429, server_error/temporarily_unavailable)
// with bounded retry — so they never fall through the SDK's auth() swallow into
// a fabricated UnauthorizedError → spurious `reauth_required`. A genuine
// invalid_grant passes straight through so the real reauth path still fires.

const TOKEN_URL = "https://dropbox.example.com/oauth2/token";

function refreshInit(): RequestInit {
  return {
    method: "POST",
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "rt_abc" }),
  };
}

function makeFetch(responses: Array<Response | (() => never)>) {
  let calls = 0;
  const impl = (_url: string | URL, _init?: RequestInit): Promise<Response> => {
    const next = responses[Math.min(calls, responses.length - 1)];
    calls++;
    if (typeof next === "function") next(); // throws (network error)
    return Promise.resolve((next as Response).clone());
  };
  return { impl, calls: () => calls };
}

// Deterministic, instant retries — no wall-clock in tests.
const fast = { sleep: (_ms: number) => Promise.resolve(), rng: () => 0 } as const;

describe("createOAuthRefreshFetch", () => {
  it("retries a transient network error on the refresh POST, then succeeds", async () => {
    const networkThrow = () => {
      throw new TypeError("fetch failed: ECONNRESET");
    };
    const ok = new Response(JSON.stringify({ access_token: "new" }), { status: 200 });
    const { impl, calls } = makeFetch([networkThrow, networkThrow, ok]);

    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, ...fast });
    const res = await wrapped(TOKEN_URL, refreshInit());

    expect(res.status).toBe(200);
    expect(calls()).toBe(3); // two transient throws, third succeeds
  });

  it("retries a transient 5xx on the refresh POST, then succeeds", async () => {
    const fail = new Response("upstream down", { status: 503 });
    const ok = new Response(JSON.stringify({ access_token: "new" }), { status: 200 });
    const { impl, calls } = makeFetch([fail, ok]);

    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, ...fast });
    const res = await wrapped(TOKEN_URL, refreshInit());

    expect(res.status).toBe(200);
    expect(calls()).toBe(2);
  });

  it("retries a 4xx carrying a transient OAuth code (temporarily_unavailable)", async () => {
    const fail = new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
      status: 400,
    });
    const ok = new Response(JSON.stringify({ access_token: "new" }), { status: 200 });
    const { impl, calls } = makeFetch([fail, ok]);

    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, ...fast });
    const res = await wrapped(TOKEN_URL, refreshInit());

    expect(res.status).toBe(200);
    expect(calls()).toBe(2);
  });

  it("does NOT retry a genuine invalid_grant — returns it on the first attempt", async () => {
    // This is the real dead-token case: it must reach the SDK unmodified so the
    // existing redirect → UnauthorizedError → reauth_required path fires.
    const dead = new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    const { impl, calls } = makeFetch([dead, dead, dead]);

    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, ...fast });
    const res = await wrapped(TOKEN_URL, refreshInit());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_grant" });
    expect(calls()).toBe(1); // no retry on a permanent rejection
  });

  it("gives up after maxAttempts on a persistent transient failure (fails fast)", async () => {
    const networkThrow = () => {
      throw new TypeError("fetch failed");
    };
    const { impl, calls } = makeFetch([networkThrow]);

    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, maxAttempts: 3, ...fast });

    await expect(wrapped(TOKEN_URL, refreshInit())).rejects.toThrow("fetch failed");
    expect(calls()).toBe(3); // bounded — does not retry forever
  });

  it("returns the last transient response when retries are exhausted", async () => {
    const fail = new Response("still down", { status: 503 });
    const { impl, calls } = makeFetch([fail]);

    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, maxAttempts: 2, ...fast });
    const res = await wrapped(TOKEN_URL, refreshInit());

    expect(res.status).toBe(503); // handed back to the SDK after the budget
    expect(calls()).toBe(2);
  });

  it("does NOT retry non-refresh requests, even on a 5xx", async () => {
    // A tool-call POST (or the authorization_code exchange) must pass straight
    // through — retrying would break tool semantics / the inline-task asymmetry.
    const toolCall: RequestInit = {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/call", id: 1 }),
    };
    const fail = new Response("server error", { status: 500 });
    const { impl, calls } = makeFetch([fail, fail]);

    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, ...fast });
    const res = await wrapped("https://dropbox.example.com/mcp", toolCall);

    expect(res.status).toBe(500);
    expect(calls()).toBe(1); // passthrough, no retry
  });

  it("does NOT retry the authorization_code exchange (only refresh_token)", async () => {
    const authCode: RequestInit = {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code: "abc" }),
    };
    const fail = new Response("upstream down", { status: 503 });
    const { impl, calls } = makeFetch([fail, fail]);

    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, ...fast });
    const res = await wrapped(TOKEN_URL, authCode);

    expect(res.status).toBe(503);
    expect(calls()).toBe(1);
  });
});

// Single-flight: N parallel tool calls hitting 401 on the same expired token
// (engine runs a turn's tool calls via Promise.all) must collapse into ONE
// upstream refresh POST — otherwise the IdP rate-limits the burst and, on
// rotating providers, the losers get invalid_grant (a spurious dead credential).
describe("createOAuthRefreshFetch single-flight", () => {
  // Each call returns a distinct token so we can prove all coalesced callers
  // received the result of the SAME upstream refresh.
  function countingTokenFetch() {
    let calls = 0;
    const impl = (_url: string | URL, _init?: RequestInit): Promise<Response> => {
      calls++;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: `tok_${calls}` }), { status: 200 }),
      );
    };
    return { impl, calls: () => calls };
  }

  it("collapses concurrent refreshes into one upstream POST; all get the same token", async () => {
    const { impl, calls } = countingTokenFetch();
    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, ...fast });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => wrapped(TOKEN_URL, refreshInit())),
    );

    expect(calls()).toBe(1); // one upstream refresh served all 5 callers
    // Each caller's Response is independently readable (proves snapshot, not a
    // shared single-use body) and carries the same token.
    const tokens = await Promise.all(results.map((r) => r.json()));
    for (const t of tokens) expect(t).toEqual({ access_token: "tok_1" });
  });

  it("does NOT coalesce a refresh that starts after the previous settled", async () => {
    const { impl, calls } = countingTokenFetch();
    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, ...fast });

    const r1 = await wrapped(TOKEN_URL, refreshInit());
    const r2 = await wrapped(TOKEN_URL, refreshInit()); // in-flight already cleared

    expect(calls()).toBe(2);
    expect(await r1.json()).toEqual({ access_token: "tok_1" });
    expect(await r2.json()).toEqual({ access_token: "tok_2" });
  });

  it("shares ONE retry sequence across coalesced callers (transient then success)", async () => {
    const fail = new Response("down", { status: 503 });
    const ok = new Response(JSON.stringify({ access_token: "tok_ok" }), { status: 200 });
    const { impl, calls } = makeFetch([fail, ok]);
    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, ...fast });

    const results = await Promise.all([
      wrapped(TOKEN_URL, refreshInit()),
      wrapped(TOKEN_URL, refreshInit()),
      wrapped(TOKEN_URL, refreshInit()),
    ]);

    expect(calls()).toBe(2); // 503 then 200, shared — NOT 3 callers × 2 attempts
    for (const r of results) expect(await r.json()).toEqual({ access_token: "tok_ok" });
  });

  it("fans a refresh failure out to all coalesced callers, with one shared attempt sequence", async () => {
    const networkThrow = () => {
      throw new TypeError("fetch failed");
    };
    const { impl, calls } = makeFetch([networkThrow]);
    const wrapped = createOAuthRefreshFetch({ fetchImpl: impl, maxAttempts: 2, ...fast });

    const settled = await Promise.allSettled([
      wrapped(TOKEN_URL, refreshInit()),
      wrapped(TOKEN_URL, refreshInit()),
      wrapped(TOKEN_URL, refreshInit()),
    ]);

    for (const s of settled) expect(s.status).toBe("rejected");
    expect(calls()).toBe(2); // one shared 2-attempt sequence, not 3 × 2 = 6
  });
});
