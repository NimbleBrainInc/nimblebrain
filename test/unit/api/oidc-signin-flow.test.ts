/**
 * The sign-in flow lives in the browser that started it.
 *
 * `GET /v1/auth/authorize` hands the browser a `__Host-nb_login` cookie holding
 * the flow's `state` and PKCE verifier, which only this host can set. The callback
 * completes only when that cookie's state equals the returned `state`, redeems
 * the code with the cookie's verifier, and clears the cookie on every answer.
 * A callback URL opened in any other browser carries no cookie and is refused,
 * and the server keeps no per-flow state, so any process can finish a flow.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleOidcAuthorize, handleOidcCallback } from "../../../src/api/handlers.ts";
import type { IdentityProvider } from "../../../src/identity/provider.ts";
import { stub } from "../../helpers/stub.ts";

const ORIGIN = "https://nb.example.com";
const APP = "https://nb.example.com";
const ENV_KEYS = [
  "NB_PUBLIC_ORIGIN",
  "NB_PLATFORM_HOST",
  "NB_CUSTOM_DOMAIN",
  "NB_CUSTOM_DOMAIN_CANONICAL",
  "NB_TENANT_ID",
];
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NB_PUBLIC_ORIGIN = ORIGIN;
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

interface Exchange {
  code: string;
  verifier: string | undefined;
}

function makeProvider(fail = false): { provider: IdentityProvider; exchanges: Exchange[] } {
  const exchanges: Exchange[] = [];
  const provider = stub<IdentityProvider>({
    capabilities: { authCodeFlow: true } as IdentityProvider["capabilities"],
    getAuthorizationUrl: () => "https://idp.example/authorize?client_id=x",
    exchangeCode: async (code: string, verifier?: string) => {
      exchanges.push({ code, verifier });
      if (fail) throw new Error("code rejected");
      return { accessToken: `token-for-${code}`, refreshToken: `refresh-for-${code}` };
    },
  });
  return { provider, exchanges };
}

function authorize(provider: IdentityProvider, url = `${ORIGIN}/v1/auth/authorize`) {
  return handleOidcAuthorize(new Request(url), provider);
}

/** The `__Host-nb_login=<value>` pair from a response, or undefined. */
function flowCookie(res: Response): string | undefined {
  return res.headers
    .getSetCookie()
    .find((c) => c.startsWith("__Host-nb_login="))
    ?.split(";")[0];
}

function callback(provider: IdentityProvider, state: string, cookie?: string, code = "the-code") {
  const headers: Record<string, string> = cookie ? { cookie } : {};
  return handleOidcCallback(
    new Request(`${ORIGIN}/v1/auth/callback?code=${code}&state=${state}`, { headers }),
    provider,
    APP,
  );
}

function stateOf(res: Response): string {
  return new URL(res.headers.get("location") ?? "").searchParams.get("state") ?? "";
}

function expectFlowCleared(res: Response): void {
  expect(res.headers.getSetCookie()).toContain(
    "__Host-nb_login=; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=0",
  );
}

function expectNoSession(res: Response): void {
  expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-nb_session="))).toBe(false);
  expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-nb_refresh="))).toBe(false);
}

describe("GET /v1/auth/authorize", () => {
  test("sets a host-only __Host-nb_login cookie whose state is the one sent to the IdP", async () => {
    const { provider } = makeProvider();
    const res = await authorize(provider);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin).toBe("https://idp.example");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const [cookie] = res.headers.getSetCookie();
    expect(cookie).toMatch(
      /^__Host-nb_login=[\w-]+\.[\w-]+; HttpOnly; SameSite=Lax; Path=\/; Secure; Max-Age=600$/,
    );
    const [cookieState] = (flowCookie(res) ?? "").slice("__Host-nb_login=".length).split(".");
    expect(cookieState).toBe(stateOf(res));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("the cookie's verifier is the one the challenge was derived from", async () => {
    const { provider } = makeProvider();
    const res = await authorize(provider);
    const [, verifier] = (flowCookie(res) ?? "").slice("__Host-nb_login=".length).split(".");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const expected = Buffer.from(digest).toString("base64url");
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("code_challenge")).toBe(
      expected,
    );
  });

  test("a non-canonical host is sent to the canonical authorize URL, with no cookie", async () => {
    const { provider } = makeProvider();
    const res = await authorize(provider, "https://other.example.org/v1/auth/authorize");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${ORIGIN}/v1/auth/authorize?canonical=1`);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  test("the canonical marker stops a second redirect", async () => {
    const { provider } = makeProvider();
    const res = await authorize(
      provider,
      "https://other.example.org/v1/auth/authorize?canonical=1",
    );

    expect(new URL(res.headers.get("location") ?? "").origin).toBe("https://idp.example");
    expect(flowCookie(res)).toBeTruthy();
  });
});

describe("GET /v1/auth/callback", () => {
  test("a callback URL opened in a browser that did not start the flow signs nobody in", async () => {
    // One browser starts the flow and signs in at the IdP; another, with no
    // cookies, follows the resulting callback URL.
    const { provider, exchanges } = makeProvider();
    const begin = await authorize(provider);
    const res = await callback(provider, stateOf(begin), undefined, "attacker-code");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}?error=auth_failed`);
    expectNoSession(res);
    expect(exchanges).toEqual([]);
  });

  test("another flow's cookie is refused", async () => {
    const { provider, exchanges } = makeProvider();
    const mine = await authorize(provider);
    const theirs = await authorize(provider);
    const res = await callback(provider, stateOf(theirs), flowCookie(mine));

    expect(res.headers.get("location")).toBe(`${APP}?error=auth_failed`);
    expectNoSession(res);
    expectFlowCleared(res);
    expect(exchanges).toEqual([]);
  });

  test("a flow under the unprefixed name is not read", async () => {
    const { provider, exchanges } = makeProvider();
    const begin = await authorize(provider);
    const value = (flowCookie(begin) ?? "").slice("__Host-nb_login=".length);
    const res = await callback(provider, stateOf(begin), `nb_login=${value}`);

    expect(res.headers.get("location")).toBe(`${APP}?error=auth_failed`);
    expectNoSession(res);
    expect(exchanges).toEqual([]);
  });

  test("a malformed cookie is refused", async () => {
    const { provider, exchanges } = makeProvider();
    const begin = await authorize(provider);
    const res = await callback(provider, stateOf(begin), `__Host-nb_login=${stateOf(begin)}`);

    expect(res.headers.get("location")).toBe(`${APP}?error=auth_failed`);
    expectNoSession(res);
    expect(exchanges).toEqual([]);
  });

  test("the matching cookie signs in, redeems with its verifier, and is cleared", async () => {
    const { provider, exchanges } = makeProvider();
    const begin = await authorize(provider);
    const cookie = flowCookie(begin) ?? "";
    const [, verifier] = cookie.slice("__Host-nb_login=".length).split(".");
    const res = await callback(provider, stateOf(begin), `other=1; ${cookie}`);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(APP);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const issued = res.headers.getSetCookie();
    expect(issued).toContain(
      "__Host-nb_session=token-for-the-code; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=3600",
    );
    expect(issued).toContain(
      "__Host-nb_refresh=refresh-for-the-code; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=2592000",
    );
    expectFlowCleared(res);
    expect(exchanges).toEqual([{ code: "the-code", verifier }]);
  });

  test("a failed code exchange still clears the flow cookie", async () => {
    const { provider } = makeProvider(true);
    const begin = await authorize(provider);
    const res = await callback(provider, stateOf(begin), flowCookie(begin));

    expect(res.headers.get("location")).toBe(`${APP}?error=auth_failed`);
    expectNoSession(res);
    expectFlowCleared(res);
  });

  test("a callback with no state clears the flow cookie", async () => {
    const { provider } = makeProvider();
    const begin = await authorize(provider);
    const res = await handleOidcCallback(
      new Request(`${ORIGIN}/v1/auth/callback?code=c`, {
        headers: { cookie: flowCookie(begin) ?? "" },
      }),
      provider,
      APP,
    );
    expect(res.headers.get("location")).toBe(`${APP}?error=auth_failed`);
    expectFlowCleared(res);
  });

  test("a callback with no code is a 400 that clears the flow cookie", async () => {
    const { provider, exchanges } = makeProvider();
    const begin = await authorize(provider);
    const res = await handleOidcCallback(
      new Request(`${ORIGIN}/v1/auth/callback?state=${stateOf(begin)}`, {
        headers: { cookie: flowCookie(begin) ?? "" },
      }),
      provider,
      APP,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expectFlowCleared(res);
    expectNoSession(res);
    expect(exchanges).toEqual([]);
  });

  test("the server holds no flow state: the first of many flows still completes", async () => {
    // What a callback on another process, or after a restart, looks like.
    const { provider, exchanges } = makeProvider();
    const first = await authorize(provider);
    for (let i = 0; i < 50; i++) await authorize(provider);
    const res = await callback(provider, stateOf(first), flowCookie(first));

    expect(res.headers.get("location")).toBe(APP);
    expect(exchanges).toHaveLength(1);
  });
});
