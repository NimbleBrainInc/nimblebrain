/**
 * Tests for OAuth 2.0 well-known discovery endpoints.
 *
 * Validates:
 * - Protected Resource Metadata (RFC 9728)
 * - Authorization Server Metadata proxy (RFC 8414)
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AppContext } from "../../../src/api/types.ts";
import { wellKnownRoutes } from "../../../src/api/routes/well-known.ts";

// ── Test helpers ──────────────────────────────────────────────────

/**
 * Build a minimal AppContext whose provider optionally declares an
 * authorization server — the only thing these routes read off it.
 */
function makeCtx(issuerHost?: string): AppContext {
  const authServer = issuerHost
    ? {
        issuer: `https://${issuerHost}`,
        metadataUrl: `https://${issuerHost}/.well-known/oauth-authorization-server`,
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

function createApp(issuerHost?: string) {
  const ctx = makeCtx(issuerHost);
  const app = new Hono();
  app.route("/", wellKnownRoutes(ctx));
  return app;
}

// ── Protected Resource Metadata ──────────────────────────────────

describe("GET /.well-known/oauth-protected-resource", () => {
  it("returns correct JSON when the provider declares an authorization server", async () => {
    const app = createApp("myapp.authkit.app");
    const res = await app.request("http://api.example.com/.well-known/oauth-protected-resource");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("http://api.example.com");
    expect(body.authorization_servers).toEqual(["https://myapp.authkit.app"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("returns 404 when the provider declares no authorization server", async () => {
    const app = createApp(undefined);
    const res = await app.request("/.well-known/oauth-protected-resource");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("MCP OAuth not configured");
  });

  it("honors X-Forwarded-Proto when behind a TLS-terminating proxy", async () => {
    const app = createApp("myapp.authkit.app");
    // Simulates ALB → pod: pod sees HTTP, but ALB sets X-Forwarded-Proto: https.
    const res = await app.request(
      "http://hq.example.com/.well-known/oauth-protected-resource",
      { headers: { "X-Forwarded-Proto": "https" } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://hq.example.com");
  });
});

// ── Authorization Server Metadata proxy ──────────────────────────

describe("GET /.well-known/oauth-authorization-server", () => {
  it("proxies the declared metadata URL", async () => {
    const upstreamMetadata = {
      issuer: "https://myapp.authkit.app",
      authorization_endpoint: "https://myapp.authkit.app/authorize",
      token_endpoint: "https://myapp.authkit.app/oauth/token",
    };

    // Mock global fetch to intercept the upstream request
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://myapp.authkit.app/.well-known/oauth-authorization-server") {
        return new Response(JSON.stringify(upstreamMetadata), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input);
    };

    try {
      const app = createApp("myapp.authkit.app");
      const res = await app.request("/.well-known/oauth-authorization-server");

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.issuer).toBe("https://myapp.authkit.app");
      expect(body.authorization_endpoint).toBe("https://myapp.authkit.app/authorize");
      expect(body.token_endpoint).toBe("https://myapp.authkit.app/oauth/token");
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
      const app = createApp("myapp.authkit.app");
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
      const app = createApp("myapp.authkit.app");
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
});
