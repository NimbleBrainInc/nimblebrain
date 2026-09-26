/**
 * Tests for OAuth 2.0 well-known discovery endpoints.
 *
 * Validates:
 * - Protected Resource Metadata (RFC 9728), one document per workspace
 * - Authorization Server Metadata proxy (RFC 8414)
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AppContext } from "../../../src/api/types.ts";
import { wellKnownRoutes } from "../../../src/api/routes/well-known.ts";

// ── Test helpers ──────────────────────────────────────────────────

/**
 * Build a minimal AppContext whose provider optionally declares an
 * authorization server — the only thing these routes read off it.
 *
 * `metadataUrl` is separately optional on the interface: an issuer that
 * publishes no metadata document to proxy declares only its `issuer`. Pass
 * `{ metadataUrl: false }` for that provider.
 */
function makeCtx(issuerHost?: string, opts: { metadataUrl?: boolean } = {}): AppContext {
  const authServer = issuerHost
    ? {
        issuer: `https://${issuerHost}`,
        ...(opts.metadataUrl === false
          ? {}
          : { metadataUrl: `https://${issuerHost}/.well-known/oauth-authorization-server` }),
      }
    : null;

  const provider = {
    capabilities: {
      authCodeFlow: false,
      tokenRefresh: false,
      managedUsers: false,
      authorizationServer: authServer !== null,
    },
    verifyRequest: async () => null,
    listUsers: async () => [],
    createUser: async () => {
      throw new Error("not implemented");
    },
    deleteUser: async () => false,
    authorizationServer: () => authServer,
  };

  return { provider } as unknown as AppContext;
}

function createApp(issuerHost?: string, opts: { metadataUrl?: boolean } = {}) {
  const ctx = makeCtx(issuerHost, opts);
  const app = new Hono();
  app.route("/", wellKnownRoutes(ctx));
  return app;
}

// ── Protected Resource Metadata ──────────────────────────────────

const ORIGIN = "https://nb.example.com";

let savedOrigin: string | undefined;
beforeEach(() => {
  savedOrigin = process.env.NB_PUBLIC_ORIGIN;
  process.env.NB_PUBLIC_ORIGIN = ORIGIN;
});
afterEach(() => {
  if (savedOrigin === undefined) delete process.env.NB_PUBLIC_ORIGIN;
  else process.env.NB_PUBLIC_ORIGIN = savedOrigin;
});

describe("GET /.well-known/oauth-protected-resource/mcp/:wsId", () => {
  it("returns the workspace's canonical resource URL and the authorization server", async () => {
    const app = createApp("auth.example.com");
    const res = await app.request(
      "http://api.example.com/.well-known/oauth-protected-resource/mcp/ws_a",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe(`${ORIGIN}/mcp/ws_a`);
    expect(body.authorization_servers).toEqual(["https://auth.example.com"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("builds the resource from the public origin, never the request's host or forwarded headers", async () => {
    const app = createApp("auth.example.com");
    const res = await app.request(
      "http://ATTACKER.example.net/.well-known/oauth-protected-resource/mcp/ws_a",
      { headers: { "X-Forwarded-Proto": "http", "X-Forwarded-Host": "attacker.example.net" } },
    );

    expect(res.status).toBe(200);
    expect((await res.json()).resource).toBe(`${ORIGIN}/mcp/ws_a`);
  });

  it("answers for any well-formed id without looking the workspace up", async () => {
    // The context has no workspace store at all: the document cannot disclose
    // whether a workspace exists, because it never asks.
    const app = createApp("auth.example.com");
    const res = await app.request("/.well-known/oauth-protected-resource/mcp/ws_nosuchworkspace");

    expect(res.status).toBe(200);
    expect((await res.json()).resource).toBe(`${ORIGIN}/mcp/ws_nosuchworkspace`);
  });

  it("returns 404 for an id that is not shaped like a workspace id", async () => {
    const app = createApp("auth.example.com");
    const res = await app.request("/.well-known/oauth-protected-resource/mcp/not-a-workspace");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the provider declares no authorization server", async () => {
    const app = createApp(undefined);
    const res = await app.request("/.well-known/oauth-protected-resource/mcp/ws_a");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("MCP OAuth not configured");
  });
});

describe("GET /.well-known/oauth-protected-resource", () => {
  it("is absent: the origin is no resource that accepts an authorization-server token", async () => {
    const app = createApp("auth.example.com");
    const res = await app.request("http://api.example.com/.well-known/oauth-protected-resource");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.resource).toBeUndefined();
    expect(body.message).toContain("/.well-known/oauth-protected-resource/mcp/<workspaceId>");
  });
});

// ── Authorization Server Metadata proxy ──────────────────────────

describe("GET /.well-known/oauth-authorization-server", () => {
  it("proxies the declared metadata URL", async () => {
    const upstreamMetadata = {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/oauth/token",
    };

    // Mock global fetch to intercept the upstream request
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify(upstreamMetadata), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input);
    };

    try {
      const app = createApp("auth.example.com");
      const res = await app.request("/.well-known/oauth-authorization-server");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.issuer).toBe("https://auth.example.com");
      expect(body.authorization_endpoint).toBe("https://auth.example.com/authorize");
      expect(body.token_endpoint).toBe("https://auth.example.com/oauth/token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 502 when upstream fetch fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network error");
    };

    try {
      const app = createApp("auth.example.com");
      const res = await app.request("/.well-known/oauth-authorization-server");

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("Failed to fetch upstream metadata");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 502 when upstream returns non-200", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response("Internal Server Error", { status: 500 });
    };

    try {
      const app = createApp("auth.example.com");
      const res = await app.request("/.well-known/oauth-authorization-server");

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error).toBe("Failed to fetch upstream metadata");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns 404 when the provider declares no authorization server", async () => {
    const app = createApp(undefined);
    const res = await app.request("/.well-known/oauth-authorization-server");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("MCP OAuth not configured");
  });

  it("returns 404 when the issuer publishes no metadata document to proxy", async () => {
    // metadataUrl is optional on AuthorizationServer: an issuer with nothing to
    // proxy still has to be discoverable through Protected Resource Metadata,
    // so only the RFC 8414 proxy declines. It must decline without reaching the
    // network — a bare fetch() of `undefined` would resolve against the test
    // runner's own origin rather than 404.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("upstream must not be fetched when there is no metadataUrl");
    }) as typeof fetch;

    try {
      const app = createApp("myapp.example.com", { metadataUrl: false });

      const discovery = await app.request(
        "http://api.example.com/.well-known/oauth-protected-resource/mcp/ws_a",
      );
      expect(discovery.status).toBe(200);
      expect((await discovery.json()).authorization_servers).toEqual([
        "https://myapp.example.com",
      ]);

      const proxied = await app.request("/.well-known/oauth-authorization-server");
      expect(proxied.status).toBe(404);
      expect((await proxied.json()).error).toBe("MCP OAuth not configured");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
