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

/** Spec-valid RFC 8414 metadata for an authorization server at `issuer`. */
function asMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
  };
}

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
        return Response.json(asMetadata("https://mcp.example.com"));
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
        return Response.json(asMetadata("https://mcp.example.com"));
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

  test("cancels an open response body instead of waiting on it", async () => {
    let cancelled = 0;
    const openStream = () =>
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      });
    globalThis.fetch = vendor((method) =>
      method === "HEAD"
        ? new Response(openStream(), { status: 404 })
        : new Response(openStream(), { status: 401 }),
    );
    const r = await checkEntry(entry, REDIRECT);
    expect(r.pass).toBe(true);
    // HEAD, the confirming GET, and discovery's initialize POST.
    expect(cancelled).toBe(3);
  });
});

describe("check-catalog-dcr discovery follows sign-in", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const REDIRECT = "https://nb.example.com/v1/mcp-auth/callback";
  const entry = {
    name: "com.example/mcp",
    description: "dcr vendor",
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: "https://mcp.example.com/app/mcp" }],
    _meta: { "ai.nimblebrain/connector": { auth: "dcr" } },
  } as Parameters<typeof checkEntry>[0];

  /**
   * A vendor that answers only at the given paths, and records every authorize
   * request. Its 401 names its protected-resource metadata, as the spec says.
   */
  function vendor(routes: Record<string, () => Response>, authorized: URL[]): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/app/mcp") {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/app/mcp", scope="read write"',
          },
        });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/app/mcp") {
        return Response.json({
          resource: "https://mcp.example.com/app/mcp",
          authorization_servers: ["https://mcp.example.com/app/auth"],
        });
      }
      if (url.pathname === "/app/auth/register")
        return Response.json({ client_id: "probe-client" });
      if (url.pathname === "/app/auth/authorize") {
        authorized.push(url);
        return new Response("login", { status: 200 });
      }
      const route = routes[url.pathname];
      return route ? route() : new Response("not found", { status: 404 });
    }) as typeof fetch;
  }

  test("finds metadata at the path-aware RFC 8414 location, as sign-in does", async () => {
    const authorized: URL[] = [];
    globalThis.fetch = vendor(
      {
        "/.well-known/oauth-authorization-server/app/auth": () =>
          Response.json(asMetadata("https://mcp.example.com/app/auth")),
      },
      authorized,
    );
    const r = await checkEntry(entry, REDIRECT);
    expect(formatStatus(r)).toBe("✓ ok (DCR + authorize end-to-end)");
    // The authorize request carries what sign-in sends: the resource and the scope.
    expect(authorized[0]?.searchParams.get("resource")).toBe("https://mcp.example.com/app/mcp");
    expect(authorized[0]?.searchParams.get("scope")).toBe("read write");
    expect(authorized[0]?.searchParams.get("redirect_uri")).toBe(REDIRECT);
  });

  test("finds metadata published only by OpenID Connect discovery", async () => {
    globalThis.fetch = vendor(
      {
        "/.well-known/openid-configuration/app/auth": () =>
          Response.json({
            ...asMetadata("https://mcp.example.com/app/auth"),
            jwks_uri: "https://mcp.example.com/app/auth/jwks",
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
      },
      [],
    );
    const r = await checkEntry(entry, REDIRECT);
    expect(r.pass).toBe(true);
    expect(r.registrationEndpoint).toBe("https://mcp.example.com/app/auth/register");
  });

  test("fails when no location sign-in reads holds the metadata", async () => {
    globalThis.fetch = vendor({}, []);
    const r = await checkEntry(entry, REDIRECT);
    expect(formatStatus(r)).toBe(
      "✗ FAIL — no AS metadata advertised registration_endpoint (RFC 7591)",
    );
  });
});
