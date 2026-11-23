import { afterEach, describe, expect, test } from "bun:test";
import {
  checkEntry,
  formatStatus,
  isBotChallenge,
  selectDcrEntries,
} from "../../scripts/check-catalog-dcr.ts";
import { readCatalogServers } from "../../src/connectors/catalog/read.ts";
import { CONNECTOR_FIXTURE_DIR } from "../helpers/connector-fixtures.ts";

/**
 * Offline coverage for the DCR rot-detector's entry selection. The
 * network probe itself can't run in `verify` (it's network-dependent by
 * design), but this keeps the script exercised by CI: importing it
 * proves its imports still resolve against the platform source, and
 * running `selectDcrEntries` over the fixture catches behavioral drift
 * in the catalog read / meta accessor it depends on. Without this the
 * tool would be an in-repo orphan — nothing else invokes it until the
 * deploy-repo gate (deployments#33) lands.
 */
describe("check-catalog-dcr selectDcrEntries", () => {
  test("picks dcr entries and skips static-auth + composio", () => {
    const servers = readCatalogServers(CONNECTOR_FIXTURE_DIR);
    const names = selectDcrEntries(servers).map((s) => s.name);
    // Fixture: Notion (dcr), Dropbox (static), Asana (composio).
    expect(names).toContain("com.notion/mcp");
    expect(names).not.toContain("com.dropbox/mcp");
    expect(names).not.toContain("io.asana/mcp");
  });

  test("excludes dcr entries that have no remote to reach", () => {
    const noRemote = selectDcrEntries([
      {
        name: "com.example/mcp",
        description: "dcr but no remote",
        version: "1.0.0",
        _meta: { "ai.nimblebrain/connector": { auth: "dcr" } },
      },
    ]);
    expect(noRemote).toHaveLength(0);
  });
});

describe("check-catalog-dcr isBotChallenge", () => {
  test("recognizes Cloudflare's challenge marker", () => {
    const res = new Response("<title>Just a moment...</title>", {
      status: 403,
      headers: { "cf-mitigated": "challenge" },
    });
    expect(isBotChallenge(res)).toBe(true);
  });

  test("treats a vendor's own 4xx as a real answer", () => {
    const res = new Response("invalid redirect", { status: 400 });
    expect(isBotChallenge(res)).toBe(false);
  });
});

describe("check-catalog-dcr checkEntry at /authorize", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const REDIRECT = "https://nb.example.com/v1/mcp-auth/callback";
  const entry = {
    name: "com.example/mcp",
    description: "dcr vendor",
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: "https://mcp.example.com/mcp" }],
    _meta: { "ai.nimblebrain/connector": { auth: "dcr" } },
  } as Parameters<typeof checkEntry>[0];

  /** A vendor whose discovery and registration succeed; `authorize` answers /authorize. */
  function vendor(authorize: () => Response): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          registration_endpoint: "https://mcp.example.com/register",
          authorization_endpoint: "https://mcp.example.com/authorize",
        });
      }
      if (url.pathname === "/register") return Response.json({ client_id: "probe-client" });
      if (url.pathname === "/authorize") return authorize();
      if (url.pathname === "/mcp") return new Response(null, { status: 401 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  test("a Cloudflare challenge passes, marked unverified", async () => {
    globalThis.fetch = vendor(
      () =>
        new Response("<title>Just a moment...</title>", {
          status: 403,
          headers: { "cf-mitigated": "challenge" },
        }),
    );
    const r = await checkEntry(entry, REDIRECT);
    expect(r.pass).toBe(true);
    expect(r.unverified).toContain("bot challenge");
    expect(formatStatus(r)).toStartWith("⚠ ok (DCR registered; ");
  });

  test("a vendor's own 400 still fails", async () => {
    globalThis.fetch = vendor(() => new Response("Invalid redirect URI", { status: 400 }));
    const r = await checkEntry(entry, REDIRECT);
    expect(r.pass).toBe(false);
    expect(r.unverified).toBeUndefined();
    expect(formatStatus(r)).toBe(
      "✗ FAIL — /authorize rejected our redirect URI: HTTP 400: Invalid redirect URI",
    );
  });

  test("a login page passes, verified end to end", async () => {
    globalThis.fetch = vendor(() => new Response("login", { status: 200 }));
    const r = await checkEntry(entry, REDIRECT);
    expect(formatStatus(r)).toBe("✓ ok (DCR + authorize end-to-end)");
  });
});

describe("check-catalog-dcr checkEntry reachability", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const REDIRECT = "https://nb.example.com/v1/mcp-auth/callback";
  const entry = {
    name: "com.example/mcp",
    description: "dcr vendor",
    version: "1.0.0",
    remotes: [{ type: "sse", url: "https://mcp.example.com/sse" }],
    _meta: { "ai.nimblebrain/connector": { auth: "dcr" } },
  } as Parameters<typeof checkEntry>[0];

  /** A vendor whose OAuth chain works; `endpoint` answers the MCP URL by method. */
  function vendor(endpoint: (method: string) => Response): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/sse") return endpoint(init?.method ?? "GET");
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          registration_endpoint: "https://mcp.example.com/register",
          authorization_endpoint: "https://mcp.example.com/authorize",
        });
      }
      if (url.pathname === "/register") return Response.json({ client_id: "probe-client" });
      if (url.pathname === "/authorize") return new Response("login", { status: 200 });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  test("a retired endpoint (410 Gone) fails", async () => {
    globalThis.fetch = vendor(() => new Response("moved to /mcp", { status: 410 }));
    const r = await checkEntry(entry, REDIRECT);
    expect(r.pass).toBe(false);
    expect(formatStatus(r)).toBe("✗ FAIL — unreachable (HTTP 410)");
  });

  test("a 404 on HEAD alone is not trusted when GET answers", async () => {
    globalThis.fetch = vendor(
      (method) => new Response(null, { status: method === "HEAD" ? 404 : 401 }),
    );
    const r = await checkEntry(entry, REDIRECT);
    expect(r.pass).toBe(true);
    expect(r.reachability.status).toBe(401);
  });
});
