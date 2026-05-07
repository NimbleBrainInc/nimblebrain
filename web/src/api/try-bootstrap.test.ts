// ---------------------------------------------------------------------------
// api/client.ts — tryBootstrap silent-refresh contract
//
// tryBootstrap is the first auth-touching call the app makes on every page
// load (App.tsx). It must route through fetchWithRefresh so that a returning
// user with an expired access-token cookie but a valid `nb_refresh` cookie
// is silently re-authed instead of being bounced to the login screen.
//
// Regression history: the original implementation used raw fetch and treated
// any 401 as "show login," producing one forced re-login per (idle hour +
// next page load). Multiple tenants reported "we get logged out several
// times a day" until this was routed through the interceptor.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setAuthToken, setOnAuthError, tryBootstrap } from "./client";

interface CallLog {
  bootstrap: number;
  refresh: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BOOTSTRAP_BODY = {
  identity: { id: "u_1", email: "u@example.com", displayName: "U" },
  workspaces: [{ id: "ws_1", name: "Personal" }],
  activeWorkspace: "ws_1",
  features: {},
  version: "test",
  buildSha: null,
} as const;

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  // Reset module state that other tests may leave dangling.
  setAuthToken(null);
  setOnAuthError(null);
});

describe("tryBootstrap", () => {
  test("returns parsed bootstrap when /v1/bootstrap returns 200 directly", async () => {
    const calls: CallLog = { bootstrap: 0, refresh: 0 };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/auth/refresh")) {
        calls.refresh++;
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/v1/bootstrap")) {
        calls.bootstrap++;
        return jsonResponse(BOOTSTRAP_BODY);
      }
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch;

    const result = await tryBootstrap();

    expect(result).not.toBeNull();
    expect(result?.activeWorkspace).toBe("ws_1");
    expect(calls.bootstrap).toBe(1);
    expect(calls.refresh).toBe(0);
  });

  test("silently refreshes on 401 and returns parsed bootstrap from the retry", async () => {
    // The bug fix: returning user has expired access-token cookie but a
    // valid `nb_refresh`. Bootstrap 401s, fetchWithRefresh hits /v1/auth/refresh,
    // and retries the bootstrap. The user must NOT see a login screen.
    const calls: CallLog = { bootstrap: 0, refresh: 0 };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/auth/refresh")) {
        calls.refresh++;
        return new Response(null, { status: 200 });
      }
      if (url.endsWith("/v1/bootstrap")) {
        calls.bootstrap++;
        return calls.bootstrap === 1
          ? new Response(null, { status: 401 })
          : jsonResponse(BOOTSTRAP_BODY);
      }
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch;

    const result = await tryBootstrap();

    expect(result).not.toBeNull();
    expect(result?.activeWorkspace).toBe("ws_1");
    expect(calls.bootstrap).toBe(2); // original 401 + retry after refresh
    expect(calls.refresh).toBe(1);
  });

  test("returns null when bootstrap 401s and refresh also fails", async () => {
    // Truly unauthenticated user (no `nb_refresh` cookie or it's invalid).
    // Refresh fetch comes back 401; tryBootstrap should resolve to null
    // so App.tsx renders the login screen.
    const calls: CallLog = { bootstrap: 0, refresh: 0 };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/auth/refresh")) {
        calls.refresh++;
        return new Response(null, { status: 401 });
      }
      if (url.endsWith("/v1/bootstrap")) {
        calls.bootstrap++;
        return new Response(null, { status: 401 });
      }
      throw new Error(`unexpected url: ${url}`);
    }) as typeof fetch;

    const result = await tryBootstrap();

    expect(result).toBeNull();
    expect(calls.refresh).toBe(1);
  });

  test("returns null on network error without throwing", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const result = await tryBootstrap();

    expect(result).toBeNull();
  });
});
