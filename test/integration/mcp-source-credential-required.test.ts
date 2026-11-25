import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { resetRefreshExchanges } from "../../src/tools/oauth-refresh-fetch.ts";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

/**
 * Some OAuth servers answer `server/discover`, `initialize` and `tools/list`
 * without a token and require one only on `tools/call`. An OAuth-only
 * connection (`requireCredential`) never sends such a server a tokenless
 * request, so it starts sign-in when it connects instead of reading as
 * connected and failing at its first tool call.
 *
 * A real Streamable HTTP server: protected resource metadata only at the
 * path-aware well-known URL, dynamic client registration, an authorize
 * endpoint that redirects straight back with a code, and a token endpoint that
 * issues and refreshes access tokens. A bearer it did not issue is refused
 * with a 401 on every request.
 */

const WS = "ws_0076759dbbe19fcc";
const SERVER = "anon-discovery-srv";
const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";

interface Vendor {
  url: string;
  issuer: string;
  /** Access tokens the server accepts. */
  valid: Set<string>;
  /** The bearer of each request to the MCP endpoint, `null` for none, with its method. */
  requests: Array<{ method: string; bearer: string | null }>;
  authorizes: () => number;
  refreshes: () => number;
  stop: () => void;
}

function startVendor(): Vendor {
  const valid = new Set<string>();
  const requests: Vendor["requests"] = [];
  const codes = new Set<string>();
  let issued = 0;
  let authorizes = 0;
  let refreshes = 0;

  const httpServer = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      const base = `http://localhost:${httpServer.port}`;
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        return Response.json(
          {
            client_id: "client-dcr",
            redirect_uris: body.redirect_uris ?? [CALLBACK],
            token_endpoint_auth_method: "none",
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/authorize") {
        authorizes++;
        const code = `code_${authorizes}`;
        codes.add(code);
        const target = new URL(url.searchParams.get("redirect_uri") ?? CALLBACK);
        target.searchParams.set("code", code);
        target.searchParams.set("state", url.searchParams.get("state") ?? "");
        return new Response(null, { status: 302, headers: { location: target.toString() } });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const form = await req.formData();
        const grant = form.get("grant_type");
        if (grant === "refresh_token") refreshes++;
        const ok =
          grant === "refresh_token"
            ? form.get("refresh_token") === "rt_1"
            : codes.has(String(form.get("code")));
        if (!ok) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const access = `at_issued_${++issued}`;
        valid.add(access);
        return Response.json({
          access_token: access,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: `rt_issued_${issued}`,
        });
      }
      if (url.pathname === "/mcp") {
        const bearer = req.headers.get("authorization")?.replace(/^Bearer /i, "") ?? null;
        const method =
          req.method === "POST"
            ? String(((await req.clone().json()) as { method?: string }).method)
            : req.method;
        requests.push({ method, bearer });
        if (bearer !== null && !valid.has(bearer)) return new Response(null, { status: 401 });
        // Anonymous discovery and listing; only a tool call needs the token.
        if (bearer === null && method === "tools/call") {
          return new Response(null, { status: 401 });
        }
        const mcp = new Server({ name: "anon", version: "0.1.0" }, { capabilities: { tools: {} } });
        mcp.setRequestHandler("tools/list", async () => ({
          tools: [
            {
              name: "listEvents",
              description: "events",
              inputSchema: { type: "object" as const, properties: {} },
            },
          ],
        }));
        mcp.setRequestHandler("tools/call", async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }));
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        await mcp.connect(transport);
        return transport.handleRequest(req);
      }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://localhost:${httpServer.port}`;
  return {
    url: `${base}/mcp`,
    issuer: base,
    valid,
    requests,
    authorizes: () => authorizes,
    refreshes: () => refreshes,
    stop: () => httpServer.stop(true),
  };
}

function makeProvider(
  opts: { headless?: boolean; onAuthLost?: () => void } = {},
): WorkspaceOAuthProvider {
  return new WorkspaceOAuthProvider({
    owner: { type: "workspace", wsId: WS },
    serverName: SERVER,
    callbackUrl: CALLBACK,
    allowInsecureRemotes: true,
    ...(opts.headless ? { headlessAuthProbe: true } : {}),
    ...(opts.onAuthLost ? { onAuthLost: opts.onAuthLost } : {}),
  });
}

async function seedTokens(issuer: string, accessToken: string): Promise<void> {
  const p = makeProvider();
  await p.saveClientInformation({ client_id: "client-dcr", redirect_uris: [CALLBACK] });
  await p.saveTokens({
    access_token: accessToken,
    token_type: "Bearer",
    refresh_token: "rt_1",
    issuer,
  } as Parameters<WorkspaceOAuthProvider["saveTokens"]>[0]);
}

const textOf = (r: { content: { type: string; text?: string }[] }) =>
  r.content.map((c) => c.text ?? "").join("\n");

describe("McpSource — OAuth-only connection to a server that serves discovery anonymously", () => {
  let vendor: Vendor;
  let source: McpSource | undefined;

  function build(provider: WorkspaceOAuthProvider, requireCredential: boolean): McpSource {
    source = new McpSource(
      SERVER,
      {
        type: "remote",
        url: new URL(vendor.url),
        allowInsecure: true,
        authProvider: provider,
        ...(requireCredential ? { requireCredential } : {}),
      },
      new NoopEventSink(),
    );
    return source;
  }

  beforeEach(() => {
    const workDir = mkdtempSync(join(tmpdir(), "nb-credential-required-"));
    seedWorkspaceRoot(workDir, WS);
    installTestCredentialStore(workDir);
    resetRefreshExchanges();
    vendor = startVendor();
  });
  afterEach(async () => {
    await source?.stop();
    source = undefined;
    vendor.stop();
    resetTestCredentialStore();
  });

  it("with no token, connecting signs in first and no tokenless request reaches the server", async () => {
    const src = build(makeProvider({ headless: true }), true);

    await src.start();
    const result = await src.execute("listEvents", {});

    expect(vendor.authorizes()).toBe(1);
    expect(result.isError).toBe(false);
    expect(textOf(result)).toBe("ok");
    expect(vendor.requests.length).toBeGreaterThan(0);
    expect(vendor.requests.every((r) => r.bearer !== null)).toBe(true);
  }, 15_000);

  it("with no token and no user to sign in, a background start fails as reauth_required", async () => {
    const onAuthLost = mock(() => {});
    const src = build(makeProvider({ onAuthLost }), true);

    await expect(src.start()).rejects.toThrow();

    expect(onAuthLost).toHaveBeenCalledTimes(1);
    expect(vendor.requests).toEqual([]);
  }, 15_000);

  it("without requireCredential the same server reads as connected with no token", async () => {
    const src = build(makeProvider({ headless: true }), false);

    await src.start();

    // The defect the option closes: connected, never signed in.
    expect(vendor.authorizes()).toBe(0);
    expect(vendor.requests.some((r) => r.bearer === null)).toBe(true);
  }, 15_000);

  it("a stored valid token goes out and the tool call succeeds without sign-in", async () => {
    vendor.valid.add("at_valid");
    await seedTokens(vendor.issuer, "at_valid");
    const src = build(makeProvider(), true);

    await src.start();
    const result = await src.execute("listEvents", {});

    expect(textOf(result)).toBe("ok");
    expect(vendor.authorizes()).toBe(0);
    expect(vendor.requests.every((r) => r.bearer === "at_valid")).toBe(true);
  }, 15_000);

  it("an expired stored token still goes out, and the server's 401 drives the refresh", async () => {
    await seedTokens(vendor.issuer, "at_expired");
    const src = build(makeProvider(), true);

    await src.start();
    const result = await src.execute("listEvents", {});

    expect(textOf(result)).toBe("ok");
    expect(vendor.requests[0]?.bearer).toBe("at_expired");
    expect(vendor.refreshes()).toBe(1);
    expect(vendor.authorizes()).toBe(0);
  }, 15_000);
});
