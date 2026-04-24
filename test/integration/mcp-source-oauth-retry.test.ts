import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";

/**
 * End-to-end coverage of the retry-once path in `McpSource.start()`:
 *   connect() → 401 UnauthorizedError → provider.awaitPendingFlow() →
 *   transport.finishAuth(code) → connect() (succeeds) → tools() works.
 *
 * The mock server implements the minimum OAuth + MCP surface the SDK
 * requires to drive an auth code + PKCE flow:
 *
 *   /.well-known/oauth-protected-resource  → advertises the auth server
 *   /.well-known/oauth-authorization-server → endpoint catalog
 *   /register                               → dynamic client registration
 *   /authorize                              → 302 to redirect_uri with code
 *   /token                                  → exchanges code for access token
 *   /mcp                                    → 401 without bearer, 200 with
 *
 * This is the test W5 in the QA review asked for — the PR's biggest
 * behavioral change previously had zero direct coverage beyond the Reboot
 * hand-exercise.
 */

const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";

interface MockOAuthMcpServer {
  port: number;
  url: string;
  stop: () => void;
}

function startMockOAuthMcpServer(): MockOAuthMcpServer {
  const ISSUED = new Map<string, { code: string }>(); // client_id → code
  const VALID_TOKENS = new Set<string>();
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const servers: Server[] = [];

  const createMcpServer = (): Server => {
    const mcpServer = new Server(
      { name: "oauth-test-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "noop",
          description: "no-op tool",
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    }));
    return mcpServer;
  };

  const httpServer = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      const base = `http://localhost:${httpServer.port}`;

      // ---- OAuth discovery ----
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: base,
          authorization_servers: [base],
        });
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

      // ---- DCR ----
      if (url.pathname === "/register" && req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        const client_id = "mock-client-" + Math.random().toString(36).slice(2, 10);
        return Response.json(
          {
            client_id,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: body.redirect_uris ?? [CALLBACK],
            grant_types: body.grant_types ?? ["authorization_code"],
            response_types: body.response_types ?? ["code"],
            token_endpoint_auth_method: body.token_endpoint_auth_method ?? "none",
          },
          { status: 201 },
        );
      }

      // ---- Authorize: 302 straight to redirect_uri with code ----
      if (url.pathname === "/authorize") {
        const state = url.searchParams.get("state") ?? "";
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? CALLBACK;
        const code = "mock-code-" + Math.random().toString(36).slice(2, 10);
        ISSUED.set(clientId, { code });
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", state);
        return new Response(null, {
          status: 302,
          headers: { location: target.toString() },
        });
      }

      // ---- Token exchange ----
      if (url.pathname === "/token" && req.method === "POST") {
        const form = await req.formData();
        const code = form.get("code");
        const clientId = form.get("client_id");
        const issued = typeof clientId === "string" ? ISSUED.get(clientId) : undefined;
        if (!issued || issued.code !== code) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const access = "mock-token-" + Math.random().toString(36).slice(2, 10);
        VALID_TOKENS.add(access);
        return Response.json({
          access_token: access,
          token_type: "Bearer",
          expires_in: 3600,
        });
      }

      // ---- MCP endpoint: 401 without bearer, 200 with ----
      if (url.pathname === "/mcp") {
        const auth = req.headers.get("authorization");
        const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : null;
        if (!token || !VALID_TOKENS.has(token)) {
          return Response.json(
            { error: "invalid_token" },
            {
              status: 401,
              headers: {
                "WWW-Authenticate": `Bearer realm="${base}", resource_metadata="${base}/.well-known/oauth-protected-resource"`,
              },
            },
          );
        }
        const mcpServer = createMcpServer();
        servers.push(mcpServer);
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        transports.push(transport);
        await mcpServer.connect(transport);
        return transport.handleRequest(req);
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    port: httpServer.port,
    url: `http://localhost:${httpServer.port}/mcp`,
    stop: () => {
      for (const t of transports) t.close?.();
      for (const s of servers) s.close?.();
      httpServer.stop(true);
    },
  };
}

describe("McpSource — OAuth retry path", () => {
  let workDir: string;
  let server: MockOAuthMcpServer;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-mcp-oauth-retry-"));
    server = startMockOAuthMcpServer();
  });

  afterEach(() => {
    server.stop();
  });

  it("401 → OAuth → 200: start() completes and tools() returns the server's tools", async () => {
    const provider = new WorkspaceOAuthProvider({
      wsId: "ws_test",
      serverName: "retry-test",
      workDir,
      callbackUrl: CALLBACK,
      // Mock runs on localhost; SSRF validator would otherwise reject.
      allowInsecureRemotes: true,
    });

    const source = new McpSource(
      "retry-test",
      {
        type: "remote",
        url: new URL(server.url),
        authProvider: provider,
      },
      new NoopEventSink(),
    );

    await source.start();
    const tools = await source.tools();
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("retry-test__noop");

    await source.stop();
  }, 15_000);
});
