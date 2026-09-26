/**
 * Tests for MCP OAuth WWW-Authenticate header generation.
 *
 * Validates that unauthenticated requests to `/mcp/<wsId>` return the correct
 * WWW-Authenticate header with Bearer error, error_description, and the
 * workspace's own resource_metadata URL for MCP client discovery.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AppContext } from "../../../src/api/types.ts";
import { mcpRoutes } from "../../../src/api/routes/mcp.ts";
import { resolveFeatures } from "../../../src/config/features.ts";
import { TransientAuthError } from "../../../src/identity/provider.ts";

// ── Test helpers ──────────────────────────────────────────────────

/**
 * Build a minimal AppContext with an auth-requiring provider that optionally
 * declares an authorization server — the only thing the 401 challenge reads.
 */
function makeCtx(opts: { issuer?: string; verify?: () => Promise<null> } = {}): AppContext {
  const verifyRequest = opts.verify ?? (async () => null);
  const authServer = opts.issuer ? { issuer: opts.issuer } : null;
  const provider = {
    capabilities: {
      authCodeFlow: true,
      tokenRefresh: true,
      managedUsers: true,
      authorizationServer: authServer !== null,
    },
    verifyRequest, // default: always reject — simulates unauthenticated
    listUsers: async () => [],
    createUser: async () => {
      throw new Error("not implemented");
    },
    deleteUser: async () => false,
    authorizationServer: () => authServer,
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

function createApp(opts: { issuer?: string; verify?: () => Promise<null> } = {}) {
  const ctx = makeCtx(opts);
  const app = new Hono();
  app.route("/", mcpRoutes(ctx));
  return app;
}

// ── WWW-Authenticate header tests ────────────────────────────────

const ORIGIN = "https://nb.example.com";
const METADATA_URL = `${ORIGIN}/.well-known/oauth-protected-resource/mcp/ws_a`;

let savedOrigin: string | undefined;
beforeEach(() => {
  savedOrigin = process.env.NB_PUBLIC_ORIGIN;
  process.env.NB_PUBLIC_ORIGIN = ORIGIN;
});
afterEach(() => {
  if (savedOrigin === undefined) delete process.env.NB_PUBLIC_ORIGIN;
  else process.env.NB_PUBLIC_ORIGIN = savedOrigin;
});

describe("MCP OAuth WWW-Authenticate header", () => {
  it("returns WWW-Authenticate with correct format when an authorization server is declared", async () => {
    const app = createApp({ issuer: "https://auth.example.com" });
    const res = await app.request("/mcp/ws_a", {
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
    expect(wwwAuth).toContain(`resource_metadata="${METADATA_URL}"`);
  });

  it("points at the workspace's own metadata on the public origin, whatever the request's host", async () => {
    // A 401 pointing at the root document would make the client request a
    // token for the origin, which /mcp/<wsId> refuses; and a host taken from
    // the request would let a caller choose the resource.
    const app = createApp({ issuer: "https://auth.example.com" });
    const res = await app.request("http://attacker.example.net/mcp/ws_a", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-Proto": "http",
        "X-Forwarded-Host": "attacker.example.net",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1 }),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${METADATA_URL}"`);
  });

  it("does not include WWW-Authenticate when no authorization server is declared", async () => {
    const app = createApp({});
    const res = await app.request("/mcp/ws_a", {
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
      issuer: "https://auth.example.com",
      verify: async () => {
        throw new TransientAuthError("jwks_unavailable", "boom");
      },
    });
    const res = await app.request("/mcp/ws_a", {
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
