import { describe, expect, test } from "bun:test";
import { createFetchWithRefresh } from "./fetch-with-refresh";

/** Minimal Response stub — only status matters for the interceptor. */
function res(status: number): Response {
  return new Response(null, { status });
}

describe("fetchWithRefresh", () => {
  test("passes through non-401 responses unchanged", async () => {
    const fakeFetch = async () => res(200);
    const fetcher = createFetchWithRefresh({
      fetch: fakeFetch as typeof fetch,
      refreshUrl: "/refresh",
    });

    const r = await fetcher("/api/data");
    expect(r.status).toBe(200);
  });

  test("retries after successful refresh and returns the retry response", async () => {
    let callCount = 0;
    const fakeFetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/refresh") return res(200);
      callCount++;
      // First call 401, second (retry) 200
      return callCount === 1 ? res(401) : res(200);
    };

    const fetcher = createFetchWithRefresh({
      fetch: fakeFetch as typeof fetch,
      refreshUrl: "/refresh",
    });

    const r = await fetcher("/api/data");
    expect(r.status).toBe(200);
    expect(callCount).toBe(2); // original + retry
  });

  test("calls onAuthError when refresh fails", async () => {
    let authErrorCalled = false;
    const fakeFetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/refresh") return res(401); // refresh fails
      return res(401);
    };

    const fetcher = createFetchWithRefresh({
      fetch: fakeFetch as typeof fetch,
      refreshUrl: "/refresh",
      onAuthError: () => {
        authErrorCalled = true;
      },
    });

    const r = await fetcher("/api/data");
    expect(r.status).toBe(401);
    expect(authErrorCalled).toBe(true);
  });

  test("calls onAuthError when retry still returns 401", async () => {
    let authErrorCalled = false;
    const fakeFetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/refresh") return res(200); // refresh succeeds
      return res(401); // but every request is still 401
    };

    const fetcher = createFetchWithRefresh({
      fetch: fakeFetch as typeof fetch,
      refreshUrl: "/refresh",
      onAuthError: () => {
        authErrorCalled = true;
      },
    });

    const r = await fetcher("/api/data");
    expect(r.status).toBe(401);
    expect(authErrorCalled).toBe(true);
  });

  test("deduplicates concurrent refresh calls", async () => {
    let refreshCount = 0;
    let apiCallCount = 0;

    const fakeFetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/refresh") {
        refreshCount++;
        // Simulate async delay so concurrent callers overlap
        await new Promise((r) => setTimeout(r, 10));
        return res(200);
      }
      apiCallCount++;
      // First 3 calls are the originals (all 401), next 3 are retries (all 200)
      return apiCallCount <= 3 ? res(401) : res(200);
    };

    const fetcher = createFetchWithRefresh({
      fetch: fakeFetch as typeof fetch,
      refreshUrl: "/refresh",
    });

    // Fire 3 requests concurrently — all get 401 simultaneously
    const results = await Promise.all([fetcher("/api/a"), fetcher("/api/b"), fetcher("/api/c")]);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(refreshCount).toBe(1); // only one refresh call
  });

  test("refresh network error is handled gracefully", async () => {
    let authErrorCalled = false;
    const fakeFetch = async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/refresh") throw new TypeError("Failed to fetch");
      return res(401);
    };

    const fetcher = createFetchWithRefresh({
      fetch: fakeFetch as typeof fetch,
      refreshUrl: "/refresh",
      onAuthError: () => {
        authErrorCalled = true;
      },
    });

    const r = await fetcher("/api/data");
    expect(r.status).toBe(401);
    expect(authErrorCalled).toBe(true);
  });
});
