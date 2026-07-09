import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BundleLifecycleManager, ConnectorBusyError } from "../../src/bundles/lifecycle.ts";
import { IdentityConnectorStore } from "../../src/identity/connector-store.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { _clearAll, peekFlowOwner } from "../../src/tools/oauth-flow-registry.ts";

/**
 * Integration: `startIdentityAuth` — the interactive OAuth flow that connects a
 * personal connector on the caller's IDENTITY (the profile "Connect" click).
 * Bound to the `{type:"user"}` owner and the `IdentityConnectorStore`, no
 * workspace. Drives the real SDK OAuth handshake against a mock authorization
 * server that 401s `/mcp`, serves discovery + DCR, and returns a NON-redirect
 * `/authorize` (200 login page) so the provider falls through to the interactive
 * branch and hands us the authorization URL.
 *
 * Asserts the identity-specific behavior: the connector resolves from the store,
 * the flow is registered under a `{kind:"user"}` owner (so the callback lands on
 * `/profile/connectors`), and the OAuth client is registered under the user's
 * identity credential root (`users/<id>/credentials/mcp-oauth/…`) — outside any
 * workspace.
 */

interface MockAS {
  base: string;
  stop: () => void;
}

function startMockAuthServer(): MockAS {
  const httpServer = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      const base = `http://localhost:${httpServer.port}`;

      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return Response.json({ resource: base, authorization_servers: [base] });
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
            client_id: `mock-client-${Math.random().toString(36).slice(2, 10)}`,
            client_id_issued_at: Math.floor(Date.now() / 1000),
            redirect_uris: body.redirect_uris ?? [],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          },
          { status: 201 },
        );
      }
      // Interactive: a real login page, NOT a redirect-with-code — so the
      // provider's redirect-probe breaks and falls through to interactive.
      if (url.pathname === "/authorize") {
        return new Response("<html><body>log in</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.pathname === "/mcp") {
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
      return new Response("not found", { status: 404 });
    },
  });
  return { base: `http://localhost:${httpServer.port}`, stop: () => httpServer.stop(true) };
}

class CapturingSink implements EventSink {
  events: EngineEvent[] = [];
  emit(event: EngineEvent): void {
    this.events.push(event);
  }
}

const USER_ID = "usr_alice";
const SERVER = "granola";

/** Path to the DCR client under the caller's identity credential root. */
function clientJsonPath(workDir: string): string {
  return join(workDir, "users", USER_ID, "credentials", "mcp-oauth", SERVER, "client.json");
}

/**
 * Retry `startIdentityAuth` until it proceeds past the busy gate (or a bounded
 * deadline). Under the old poison-slot bug this never escaped — every retry got
 * the cached rejection; under the single-gate design it recovers once the prior
 * start settles and frees the gate.
 */
async function retryConnect(
  lifecycle: BundleLifecycleManager,
  workDir: string,
  timeoutMs = 10_000,
): Promise<{ authorizationUrl: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await lifecycle.startIdentityAuth(SERVER, USER_ID, {
        workDir,
        allowInsecureRemotes: true,
      });
    } catch (err) {
      if (!(err instanceof ConnectorBusyError)) throw err;
      if (Date.now() > deadline) {
        throw new Error("Connect never recovered from busy — the gate appears poisoned");
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

describe("lifecycle.startIdentityAuth — interactive OAuth for a personal connector", () => {
  let workDir: string;
  let mock: MockAS;
  let lifecycle: BundleLifecycleManager;

  beforeEach(async () => {
    workDir = mkdtempSync(join(tmpdir(), "nb-identity-oauth-"));
    mock = startMockAuthServer();
    lifecycle = new BundleLifecycleManager(new CapturingSink(), undefined, /* allowInsecure */ true);
    // The connector is installed on the caller's identity — no workspace.
    await new IdentityConnectorStore({ workDir }).add(USER_ID, {
      url: `${mock.base}/mcp`,
      serverName: SERVER,
      ui: null,
    });
  });

  afterEach(() => {
    _clearAll();
    mock.stop();
  });

  it("opens an interactive flow: returns an auth URL, registers a user-owned flow, and binds credentials to the identity", async () => {
    const { authorizationUrl } = await lifecycle.startIdentityAuth(SERVER, USER_ID, {
      workDir,
      allowInsecureRemotes: true,
    });

    // An authorization URL was captured (the interactive branch fired).
    expect(authorizationUrl).toContain("/authorize");
    const state = new URL(authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();

    // The flow is owned by the USER, so the callback lands on /profile/connectors.
    expect(peekFlowOwner(state as string)).toEqual({ kind: "user", userId: USER_ID });

    // The OAuth client (DCR) was registered under the user's identity credential
    // root — `users/<id>/credentials/mcp-oauth/<server>/` — outside any workspace.
    const clientJson = join(
      workDir,
      "users",
      USER_ID,
      "credentials",
      "mcp-oauth",
      SERVER,
      "client.json",
    );
    expect(existsSync(clientJson)).toBe(true);
    // And NOT under any workspace tree.
    expect(existsSync(join(workDir, "workspaces"))).toBe(false);
  }, 20_000);

  it("rejects a connector the caller has not installed on their identity", async () => {
    await expect(
      lifecycle.startIdentityAuth("not-installed", USER_ID, { workDir, allowInsecureRemotes: true }),
    ).rejects.toThrow(/not a personal connector/);
  });

  it("rejects a second concurrent Connect as busy — one auth chain, no DCR clobber", async () => {
    // Two simultaneous Connects: one claims the shared start gate; the other
    // finds it held and is rejected `ConnectorBusyError`. The loser must NOT
    // spawn a rival auth() chain that would clobber client.json / verifier.json.
    const a = lifecycle.startIdentityAuth(SERVER, USER_ID, { workDir, allowInsecureRemotes: true });
    const b = lifecycle.startIdentityAuth(SERVER, USER_ID, { workDir, allowInsecureRemotes: true });
    const settled = await Promise.allSettled([a, b]);

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConnectorBusyError);
    expect(
      (fulfilled[0] as PromiseFulfilledResult<{ authorizationUrl: string }>).value.authorizationUrl,
    ).toContain("/authorize");

    // Exactly one DCR client under the identity root (one auth chain, no clobber).
    expect(existsSync(clientJsonPath(workDir))).toBe(true);
  }, 20_000);

  it("a busy rejection does not poison the gate — a later Connect recovers", async () => {
    // Regression for the poison-slot brick: a concurrent busy rejection must not
    // wedge the shared gate. Race two Connects — one wins, one is rejected busy.
    const settled = await Promise.allSettled([
      lifecycle.startIdentityAuth(SERVER, USER_ID, { workDir, allowInsecureRemotes: true }),
      lifecycle.startIdentityAuth(SERVER, USER_ID, { workDir, allowInsecureRemotes: true }),
    ]);
    expect(settled.filter((s) => s.status === "rejected")).toHaveLength(1);

    // Abandon the winner's still-pending interactive flow (as if the user never
    // returned / the flow TTL expired) so its background start settles and frees
    // the gate. Under the old two-map design the busy reject had already wedged a
    // separate coalesce slot with a permanently-cached rejection — no gate-
    // freeing ever recovered. Under the single gate, a fresh Connect proceeds.
    _clearAll();
    const later = await retryConnect(lifecycle, workDir);
    expect(later.authorizationUrl).toContain("/authorize");
  }, 20_000);

  it("a concurrent dispatch lazy-start joins the interactive flow — no parallel source", async () => {
    // Connect claims the shared start gate synchronously (before its awaits), so
    // a dispatch racing it JOINS the interactive source instead of building a
    // second one over the same credential root (which would clobber DCR state).
    const [authResult, dispatchSource] = await Promise.all([
      lifecycle.startIdentityAuth(SERVER, USER_ID, { workDir, allowInsecureRemotes: true }),
      lifecycle.getIdentityConnectorSource(USER_ID, SERVER, workDir),
    ]);
    expect(authResult.authorizationUrl).toContain("/authorize");
    // The dispatch joined the interactive (pending) source rather than getting
    // nothing or a rival source.
    expect(dispatchSource?.name).toBe(SERVER);
    const clientJson = join(
      workDir,
      "users",
      USER_ID,
      "credentials",
      "mcp-oauth",
      SERVER,
      "client.json",
    );
    expect(existsSync(clientJson)).toBe(true);
  }, 20_000);
});
