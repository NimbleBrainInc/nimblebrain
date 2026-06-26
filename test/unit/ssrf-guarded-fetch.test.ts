import { describe, expect, test } from "bun:test";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createSsrfGuardedFetch } from "../../src/tools/ssrf-guarded-fetch.ts";

/**
 * Build a stub fetch that returns canned responses keyed by URL. Each entry is
 * either a terminal `{ status }` or a redirect `{ status, location }`. Records
 * every call so tests can assert hop count and that `redirect: "manual"` is
 * always used (the whole point — the SDK's default `follow` is what we replace).
 */
function stubFetch(routes: Record<string, { status: number; location?: string }>): {
  fetch: FetchLike;
  calls: Array<{ url: string; redirect: RequestRedirect | undefined }>;
} {
  const calls: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, redirect: init?.redirect });
    const route = routes[url];
    if (!route) throw new Error(`stub fetch: no route for ${url}`);
    const headers = route.location ? { location: route.location } : undefined;
    return new Response(null, { status: route.status, headers });
  };
  return { fetch, calls };
}

describe("createSsrfGuardedFetch", () => {
  test("passes a non-redirect response straight through (manual redirect mode)", async () => {
    const { fetch, calls } = stubFetch({ "https://good.example.com/mcp": { status: 200 } });
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: false, fleetInternal: false });

    const res = await guarded("https://good.example.com/mcp");

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.redirect).toBe("manual");
  });

  test("blocks a redirect to cloud metadata (IMDS)", async () => {
    // Hop 0 is a public host that passes; it answers with a 307 into the
    // link-local metadata range. The guard must reject the second hop.
    const { fetch, calls } = stubFetch({
      "https://evil.example.com/mcp": {
        status: 307,
        location: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
      },
    });
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: false, fleetInternal: false });

    // Caught as a cross-origin redirect before the metadata URL is ever fetched.
    await expect(guarded("https://evil.example.com/mcp")).rejects.toThrow(/cross-origin/);
    expect(calls.map((c) => c.url)).toEqual(["https://evil.example.com/mcp"]);
  });

  test("blocks a redirect to a loopback address", async () => {
    const { fetch } = stubFetch({
      "https://evil.example.com/mcp": { status: 302, location: "http://127.0.0.1:8080/admin" },
    });
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: false, fleetInternal: false });

    await expect(guarded("https://evil.example.com/mcp")).rejects.toThrow(/cross-origin/);
  });

  test("refuses a cross-origin redirect even to another public HTTPS host", async () => {
    // Cross-origin is refused regardless of the target's reputation: it is the
    // SSRF pivot AND would leak the connection's credential headers to a new
    // trust scope. The second host must never be contacted.
    const { fetch, calls } = stubFetch({
      "https://a.example.com/mcp": { status: 301, location: "https://b.example.com/mcp" },
      "https://b.example.com/mcp": { status: 200 },
    });
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: false, fleetInternal: false });

    await expect(guarded("https://a.example.com/mcp")).rejects.toThrow(/cross-origin/);
    expect(calls.map((c) => c.url)).toEqual(["https://a.example.com/mcp"]);
  });

  test("follows a same-origin redirect (path normalization)", async () => {
    const { fetch, calls } = stubFetch({
      "https://a.example.com/mcp": { status: 301, location: "https://a.example.com/mcp/" },
      "https://a.example.com/mcp/": { status: 200 },
    });
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: false, fleetInternal: false });

    const res = await guarded("https://a.example.com/mcp");

    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "https://a.example.com/mcp",
      "https://a.example.com/mcp/",
    ]);
  });

  test("refuses a cross-origin (different in-cluster service) redirect from a fleet endpoint", async () => {
    // The configured fleet URL is an in-cluster .svc over plain http — legal on
    // hop 0 with fleetInternal. A 307 to a DIFFERENT in-cluster service is the
    // SSRF we block: it is cross-origin, so the credential-bearing fleet token
    // never reaches the second service.
    const { fetch, calls } = stubFetch({
      "http://people.fleet.svc.cluster.local/mcp": {
        status: 307,
        location: "http://billing.fleet.svc.cluster.local/admin",
      },
    });
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: false, fleetInternal: true });

    await expect(guarded("http://people.fleet.svc.cluster.local/mcp")).rejects.toThrow(
      /cross-origin/,
    );
    expect(calls).toHaveLength(1); // never reached the second service
  });

  test("follows a same-origin redirect on a fleet-internal http endpoint", async () => {
    // A same-origin (same host:port) http→http normalization on a fleet source
    // is benign and must still work — fleetInternal applies on every hop because
    // the origin never changes.
    const { fetch, calls } = stubFetch({
      "http://people.fleet.svc.cluster.local/mcp": {
        status: 308,
        location: "http://people.fleet.svc.cluster.local/mcp/",
      },
      "http://people.fleet.svc.cluster.local/mcp/": { status: 200 },
    });
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: false, fleetInternal: true });

    const res = await guarded("http://people.fleet.svc.cluster.local/mcp");

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test("rejects an over-long redirect chain", async () => {
    // Same-origin bounces (distinct paths) — each hop is individually valid, but
    // the chain length itself is the signal.
    const routes: Record<string, { status: number; location?: string }> = {};
    for (let i = 0; i < 12; i++) {
      routes[`https://h.example.com/${i}`] = {
        status: 302,
        location: `https://h.example.com/${i + 1}`,
      };
    }
    const { fetch } = stubFetch(routes);
    const guarded = createSsrfGuardedFetch(fetch, { allowInsecure: false, fleetInternal: false });

    await expect(guarded("https://h.example.com/0")).rejects.toThrow(/redirect hops/);
  });

  test("falls back to global fetch shape when no base fetch is given", () => {
    // Smoke: undefined baseFetch must still yield a callable FetchLike.
    const guarded = createSsrfGuardedFetch(undefined, { allowInsecure: false, fleetInternal: false });
    expect(typeof guarded).toBe("function");
  });
});
