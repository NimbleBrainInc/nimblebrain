/**
 * Tests for MCP OAuth WWW-Authenticate header generation.
 *
 * Validates that unauthenticated requests to MCP routes return the correct
 * WWW-Authenticate header with Bearer error, error_description, and
 * resource_metadata URL for MCP client discovery.
 */

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AppContext } from "../../../src/api/types.ts";
import { mcpRoutes } from "../../../src/api/routes/mcp.ts";
import { resolveFeatures } from "../../../src/config/features.ts";
import { TransientAuthError } from "../../../src/identity/provider.ts";

// ── Test helpers ──────────────────────────────────────────────────

/** Build a minimal AppContext with an auth-requiring provider that has AuthKit configured. */
function makeCtx(opts: { authkitDomain?: string; verify?: () => Promise<null> } = {}): AppContext {
  const verifyRequest = opts.verify ?? (async () => null);
  const provider = opts.authkitDomain
    ? {
        capabilities: { authCodeFlow: true, tokenRefresh: true, managedUsers: true },
        verifyRequest, // default: always reject — simulates unauthenticated
        listUsers: async () => [],
        createUser: async () => {
          throw new Error("not implemented");
        },
        deleteUser: async () => false,
        getAuthkitDomain: () => opts.authkitDomain,
      }
    : {
        capabilities: { authCodeFlow: true, tokenRefresh: true, managedUsers: true },
        verifyRequest,
        listUsers: async () => [],
        createUser: async () => {
          throw new Error("not implemented");
        },
        deleteUser: async () => false,
      };

  return {
    provider,
    authOptions: {
      mode: { type: "adapter", provider },
      eventSink: { emit: () => {} },
      internalToken: "test-internal-token",
    },
    runtime: {
      getFeatures: () => resolveFeatures(),
    },
    workspaceStore: null,
  } as unknown as AppContext;
}

function createApp(opts: { authkitDomain?: string; verify?: () => Promise<null> } = {}) {
  const ctx = makeCtx(opts);
  const app = new Hono();
  app.route("/", mcpRoutes(ctx));
  return app;
}

// ── WWW-Authenticate header tests ────────────────────────────────

describe("MCP OAuth WWW-Authenticate header", () => {
  it("returns WWW-Authenticate with correct format when AuthKit is configured", async () => {
    const app = createApp({ authkitDomain: "myapp" });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Host: "api.example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get("WWW-Authenticate");
    expect(wwwAuth).not.toBeNull();

    // Verify the three expected components
    expect(wwwAuth).toContain('Bearer error="unauthorized"');
    expect(wwwAuth).toContain('error_description="Authorization required"');
    expect(wwwAuth).toContain("resource_metadata=");
    expect(wwwAuth).toContain("/.well-known/oauth-protected-resource");
  });

  it("resource_metadata URL derives from the request origin", async () => {
    const app = createApp({ authkitDomain: "myapp" });
    const res = await app.request("http://custom-host.example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get("WWW-Authenticate");
    expect(wwwAuth).toContain(
      'resource_metadata="http://custom-host.example.com/.well-known/oauth-protected-resource"',
    );
  });

  it("honors X-Forwarded-Proto when behind a TLS-terminating proxy", async () => {
    const app = createApp({ authkitDomain: "myapp" });
    // Simulates ALB → pod: pod sees HTTP, but ALB sets X-Forwarded-Proto: https
    // The Host header stays as the public host (ALB forwards it verbatim).
    const res = await app.request("http://hq.example.com/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    expect(res.status).toBe(401);

    const wwwAuth = res.headers.get("WWW-Authenticate");
    expect(wwwAuth).toContain(
      'resource_metadata="https://hq.example.com/.well-known/oauth-protected-resource"',
    );
  });

  it("does not include WWW-Authenticate when AuthKit is not configured", async () => {
    const app = createApp({});
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    // Should still be 401 but without the WWW-Authenticate header
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get("WWW-Authenticate");
    expect(wwwAuth).toBeNull();
  });
});

// ── Unavailability must not read as unauthenticated ──────────────

describe("MCP auth — transient unavailability", () => {
  it("answers 503 without WWW-Authenticate when verification is unavailable", async () => {
    const app = createApp({
      authkitDomain: "myapp",
      verify: async () => {
        throw new TransientAuthError("jwks_unavailable", "boom");
      },
    });
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "api.example.com" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    // The discovery header advertises "re-authenticate here". Attaching it to
    // an outage would send every MCP client into an OAuth flow it does not
    // need, and the flow would fail for the same reason verification did.
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });
});
