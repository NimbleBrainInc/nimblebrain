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
