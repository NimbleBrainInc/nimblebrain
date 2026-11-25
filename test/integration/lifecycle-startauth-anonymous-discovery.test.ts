import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { WORKSPACE_PRINCIPAL_ID } from "../../src/connectors/runtime/connection.ts";
import { ConnectorLifecycleManager } from "../../src/connectors/runtime/lifecycle.ts";
import type { ConnectorInstance, ConnectorRef } from "../../src/connectors/runtime/types.ts";
import { _clearAll } from "../../src/tools/oauth-flow-registry.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

/**
 * Reconnect (`lifecycle.startAuth`) on a server that answers discovery and
 * `tools/list` without a token and requires one only on `tools/call`. An
 * OAuth-only connection (here, a ref naming its own OAuth client) returns an
 * authorization URL. A connector added by URL alone may be a server that needs
 * no sign-in, so it still connects anonymously and reports "already
 * connected" (`null`).
 *
 * Integration tier: real `Bun.serve`, real SDK OAuth handshake. `/authorize` is
 * a login page, so the flow parks on the interactive branch.
 */

const WS = "ws_0076759dbbe19fcc";
const SERVER = "anon-discovery-startauth";

function startVendor(): { base: string; stop: () => void } {
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
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/authorize") {
        return new Response("<html><body>log in</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.pathname === "/mcp") {
        if (req.method === "POST" && !req.headers.has("authorization")) {
          const body = (await req.clone().json()) as { method?: string };
          if (body.method === "tools/call") return new Response(null, { status: 401 });
        }
        const mcp = new Server({ name: "anon", version: "0.1.0" }, { capabilities: { tools: {} } });
        mcp.setRequestHandler("tools/list", async () => ({ tools: [] }));
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
  return { base: `http://localhost:${httpServer.port}`, stop: () => httpServer.stop(true) };
}

describe("lifecycle.startAuth — a server that serves discovery anonymously", () => {
  let workDir: string;
  let vendor: { base: string; stop: () => void };
  let lifecycle: ConnectorLifecycleManager;

  function install(fields: Partial<ConnectorRef>): void {
    const ref: ConnectorRef = {
      url: `${vendor.base}/mcp`,
      serverName: SERVER,
      oauthScope: "workspace",
      ...fields,
    };
    const instance: ConnectorInstance = {
      serverName: SERVER,
      connectorName: ref.url,
      version: "remote",
      state: "starting",
      ui: null,
      wsId: WS,
      oauthScope: "workspace",
      ref,
    };
    // biome-ignore lint/suspicious/noExplicitAny: reach into the private instance map the same way the sibling startAuth harness does.
    (lifecycle as any).instances.set(`${SERVER}|${WS}`, instance);
  }

  const startAuth = () =>
    lifecycle.startAuth(SERVER, WS, WORKSPACE_PRINCIPAL_ID, {
      workDir,
      callbackUrl: `${vendor.base}/callback`,
      allowInsecureRemotes: true,
    });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-startauth-anon-"));
    seedWorkspaceRoot(workDir, WS);
    installTestCredentialStore(workDir);
    vendor = startVendor();
    lifecycle = new ConnectorLifecycleManager(new NoopEventSink());
  });

  afterEach(() => {
    _clearAll();
    resetTestCredentialStore();
    vendor.stop();
  });

  it("an OAuth-only connection returns an authorization URL, not 'already connected'", async () => {
    install({ oauthClient: { clientId: "client-1" } });

    const { authorizationUrl } = await startAuth();

    expect(authorizationUrl).not.toBeNull();
    expect(new URL(authorizationUrl as string).pathname).toBe("/authorize");
    const conn = lifecycle.getInstance(SERVER, WS)?.connections?.get(WORKSPACE_PRINCIPAL_ID);
    expect(conn?.state).toBe("pending_auth");
  }, 20_000);

  it("a connector added by URL alone still connects without a token", async () => {
    install({});

    const { authorizationUrl } = await startAuth();

    expect(authorizationUrl).toBeNull();
  }, 20_000);
});
