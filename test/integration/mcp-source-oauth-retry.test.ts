import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { resolveWithCode, takeScopeFallback } from "../../src/tools/oauth-flow-registry.ts";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../helpers/credential-store.ts";
import { seedWorkspaceRoot } from "../helpers/test-workspace.ts";

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
  /** The account the next sign-in authenticates as, for an `oidc` server. */
  account: { sub: string; email: string };
  /** The `scope` of each authorize request, in order. */
  authorizeScopes: Array<string | null>;
  stop: () => void;
}

/**
 * `oidc`: the authorization server also does OpenID Connect the way many MCP
 * servers do — `openid` and `email` advertised, a userinfo endpoint, and no
 * id_token in the token response — while the resource's own metadata names
 * only its `mcp` scope.
 *
 * `refusesIdentity`: an `oidc` server that still refuses `openid` to this
 * client, answering `invalid_scope` on the redirect, while its userinfo
 * endpoint answers any token.
 */
function startMockOAuthMcpServer(
  opts: { oidc?: boolean; refusesIdentity?: boolean } = {},
): MockOAuthMcpServer {
  const ISSUED = new Map<string, { code: string; scope: string }>(); // client_id → code
  const VALID_TOKENS = new Map<string, { scope: string; sub: string; email: string }>();
  const authorizeScopes: Array<string | null> = [];
  const mock = { account: { sub: "user-a", email: "a@example.com" } };
  const transports: WebStandardStreamableHTTPServerTransport[] = [];
  const servers: Server[] = [];

  const createMcpServer = (): Server => {
    const mcpServer = new Server(
      { name: "oauth-test-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    mcpServer.setRequestHandler("tools/list", async () => ({
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
          ...(opts.oidc ? { scopes_supported: ["mcp"] } : {}),
        });
      }
      if (url.pathname === "/.well-known/openid-configuration" && opts.oidc) {
        return Response.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          userinfo_endpoint: `${base}/userinfo`,
          scopes_supported: ["mcp", "openid", "email"],
        });
      }
      if (url.pathname === "/userinfo" && opts.oidc) {
        const auth = req.headers.get("authorization") ?? "";
        const grant = VALID_TOKENS.get(auth.replace(/^Bearer /, ""));
        // A server that refuses `openid` may still answer userinfo for any
        // token, so the account a sign-in names must not rest on it refusing.
        const granted =
          grant && (opts.refusesIdentity || grant.scope.split(" ").includes("openid"));
        if (!granted) return new Response(null, { status: 401 });
        return Response.json({ sub: grant.sub, email: grant.email });
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
        const client_id = `mock-client-${Math.random().toString(36).slice(2, 10)}`;
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
        const code = `mock-code-${Math.random().toString(36).slice(2, 10)}`;
        const scope = url.searchParams.get("scope");
        authorizeScopes.push(scope);
        if (opts.refusesIdentity && scope?.split(" ").includes("openid")) {
          const refused = new URL(redirectUri);
          refused.searchParams.set("error", "invalid_scope");
          refused.searchParams.set("state", state);
          return new Response(null, { status: 302, headers: { location: refused.toString() } });
        }
        ISSUED.set(clientId, { code, scope: scope ?? "" });
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
        const access = `mock-token-${Math.random().toString(36).slice(2, 10)}`;
        VALID_TOKENS.set(access, { scope: issued.scope, ...mock.account });
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
    get account() {
      return mock.account;
    },
    set account(account) {
      mock.account = account;
    },
    authorizeScopes,
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
    seedWorkspaceRoot(workDir, "ws_test");
    // The provider's tokens, verifier and DCR registration are all keys in the
    // installed credential store, so this suite has to install one rooted at
    // its OWN workDir. Without it the writes land in whatever store an earlier
    // file left installed — which is why this failed in isolation.
    installTestCredentialStore(workDir);
    server = startMockOAuthMcpServer();
  });

  afterEach(() => {
    resetTestCredentialStore();
    server.stop();
  });

  it("401 → OAuth → 200: start() completes and tools() returns the server's tools", async () => {
    const provider = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "retry-test",
      workDir,
      callbackUrl: CALLBACK,
      // Mock runs on localhost; SSRF validator would otherwise reject.
      allowInsecureRemotes: true,
      // This test exercises the headless 302→code path, which only runs
      // when the redirect probe is enabled (off by default now).
      headlessAuthProbe: true,
    });

    const source = new McpSource(
      "retry-test",
      {
        type: "remote",
        url: new URL(server.url),
        // Mock runs on localhost; the transport's SSRF guard would otherwise
        // reject the plain-http URL (matches the provider's allowInsecureRemotes).
        allowInsecure: true,
        authProvider: provider,
      },
      new NoopEventSink(),
    );

    // The OAuth-retry success path is a SECOND success seam inside start().
    // It must emit the readiness signal (subscribeToolsChanged) just like the
    // normal seam, or a union memoized while this remote OAuth source was
    // unreachable would never refresh — the stale-union bug, on this branch.
    let readinessFires = 0;
    source.subscribeToolsChanged(() => {
      readinessFires++;
    });

    await source.start();
    const tools = await source.tools();
    expect(tools.length).toBe(1);
    expect(tools[0]?.name).toBe("retry-test__noop");
    // Connect completed via the retry seam → exactly one readiness emit.
    expect(readinessFires).toBe(1);

    await source.stop();
  }, 15_000);

  it("a tools() read during pending auth does not pin an empty list once auth completes", async () => {
    let authorizationUrl: string | undefined;
    const pending = Promise.withResolvers<void>();
    const provider = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "pending-test",
      workDir,
      callbackUrl: CALLBACK,
      allowInsecureRemotes: true,
      onInteractiveAuthRequired: (url) => {
        authorizationUrl = url;
        pending.resolve();
      },
    });
    // A user-initiated connect: the browser flow is allowed, so start() parks
    // on the pending flow instead of failing fast.
    provider.setInteractiveAuthAllowed(true);

    const source = new McpSource(
      "pending-test",
      {
        type: "remote",
        url: new URL(server.url),
        allowInsecure: true,
        authProvider: provider,
      },
      new NoopEventSink(),
    );

    const started = source.start();
    await pending.promise;

    // The source is registered at pending auth, so a registry build or a
    // status read asks it for tools before its client has connected.
    await expect(source.tools()).rejects.toThrow(/not started/);

    // The user completes the browser flow; the callback route resolves it.
    if (!authorizationUrl) throw new Error("no authorization URL");
    const redirect = await fetch(authorizationUrl, { redirect: "manual" });
    const callback = new URL(redirect.headers.get("location") ?? "");
    const state = callback.searchParams.get("state") ?? "";
    const code = callback.searchParams.get("code") ?? "";
    expect(resolveWithCode(state, code)).toBe(true);
    await started;

    const tools = await source.tools();
    expect(tools.map((t) => t.name)).toEqual(["pending-test__noop"]);

    await source.stop();
  }, 15_000);

  it("a reconnect whose code exchange carries no id_token clears the prior identity", async () => {
    const provider = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "reauth-test",
      workDir,
      callbackUrl: CALLBACK,
      allowInsecureRemotes: true,
      headlessAuthProbe: true,
    });
    // A prior sign-in with an id_token and no refresh_token, whose access token
    // the server no longer accepts: the next connect goes straight to a new
    // authorization, and the mock's token response carries no id_token.
    const header = btoa(JSON.stringify({ alg: "RS256" })).replace(/=/g, "");
    const payload = btoa(JSON.stringify({ sub: "user-a", email: "a@example.com" })).replace(
      /=/g,
      "",
    );
    await provider.saveTokens({
      access_token: "expired",
      token_type: "Bearer",
      id_token: `${header}.${payload}.s`,
    });
    expect(await provider.identity()).not.toBeNull();

    const source = new McpSource(
      "reauth-test",
      {
        type: "remote",
        url: new URL(server.url),
        allowInsecure: true,
        authProvider: provider,
      },
      new NoopEventSink(),
    );

    await source.start();
    expect((await provider.tokens())?.access_token).toStartWith("mock-token-");
    expect(await provider.identity()).toBeNull();

    await source.stop();
  }, 15_000);

  it("a server without an id_token names the account from userinfo, and a reconnect as another account replaces it", async () => {
    server.stop();
    server = startMockOAuthMcpServer({ oidc: true });
    const provider = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "userinfo-test",
      workDir,
      callbackUrl: CALLBACK,
      allowInsecureRemotes: true,
      headlessAuthProbe: true,
    });
    const connect = async (): Promise<void> => {
      const source = new McpSource(
        "userinfo-test",
        {
          type: "remote",
          url: new URL(server.url),
          allowInsecure: true,
          authProvider: provider,
        },
        new NoopEventSink(),
      );
      await source.start();
      await source.stop();
    };

    await connect();
    // The resource names only `mcp`; the identity scopes come from the AS.
    expect(server.authorizeScopes).toEqual(["mcp openid email"]);
    expect(await provider.identity()).toEqual({ sub: "user-a", email: "a@example.com" });

    // The access token lapses and the user signs in again, as someone else.
    server.account = { sub: "user-b", email: "b@example.com" };
    await provider.saveTokens({ access_token: "expired", token_type: "Bearer" });
    await connect();
    expect(await provider.identity()).toEqual({ sub: "user-b", email: "b@example.com" });
  }, 15_000);

  /**
   * Connect through the browser flow, as the callback route drives it: a
   * redirect that answers `invalid_scope` goes on to the flow's fallback.
   */
  const connectInteractively = async (
    serverName: string,
  ): Promise<{ provider: WorkspaceOAuthProvider; offered: string[] }> => {
    const pending = Promise.withResolvers<string>();
    // Each authorize URL the connection offers, as Connect would hand it out.
    const offered: string[] = [];
    const provider = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName,
      workDir,
      callbackUrl: CALLBACK,
      allowInsecureRemotes: true,
      onInteractiveAuthRequired: (url) => {
        offered.push(url);
        pending.resolve(url);
      },
    });
    provider.setInteractiveAuthAllowed(true);
    const source = new McpSource(
      serverName,
      { type: "remote", url: new URL(server.url), allowInsecure: true, authProvider: provider },
      new NoopEventSink(),
    );
    const started = source.start();

    let authorize = await pending.promise;
    for (;;) {
      const redirect = await fetch(authorize, { redirect: "manual" });
      const callback = new URL(redirect.headers.get("location") ?? "");
      const state = callback.searchParams.get("state") ?? "";
      if (callback.searchParams.get("error") === "invalid_scope") {
        const fallback = takeScopeFallback(state);
        if (!fallback) throw new Error("invalid_scope with no fallback left");
        authorize = fallback;
        continue;
      }
      expect(resolveWithCode(state, callback.searchParams.get("code") ?? "")).toBe(true);
      break;
    }
    await started;
    expect((await source.tools()).map((t) => t.name)).toEqual([`${serverName}__noop`]);
    await source.stop();
    return { provider, offered };
  };

  it("a server that advertises openid and refuses it still signs in, naming no account", async () => {
    server.stop();
    server = startMockOAuthMcpServer({ oidc: true, refusesIdentity: true });

    const { provider, offered } = await connectInteractively("refuses-identity");

    // Once with the identity scopes, once with the connector's own scope only.
    expect(server.authorizeScopes).toEqual(["mcp openid email", "mcp"]);
    // Connect again during the flow resumes the request the server accepts.
    expect(new URL(offered.at(-1) ?? "").searchParams.get("scope")).toBe("mcp");
    expect((await provider.tokens())?.access_token).toStartWith("mock-token-");
    expect(await provider.identity()).toBeNull();
  }, 15_000);

  it("a server that accepts openid names the account through the browser flow", async () => {
    server.stop();
    server = startMockOAuthMcpServer({ oidc: true });

    const { provider } = await connectInteractively("accepts-identity");

    expect(server.authorizeScopes).toEqual(["mcp openid email"]);
    expect(await provider.identity()).toEqual({ sub: "user-a", email: "a@example.com" });
  }, 15_000);
});
