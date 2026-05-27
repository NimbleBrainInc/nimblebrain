import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { WORKSPACE_PRINCIPAL_ID } from "../../src/bundles/connection.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { BundleInstance, BundleRef } from "../../src/bundles/types.ts";
import type { EngineEvent, EventSink } from "../../src/engine/types.ts";
import { _clearAll, resolveWithCode } from "../../src/tools/oauth-flow-registry.ts";

/**
 * Regression for the silent interactive-OAuth hang fixed in
 * `lifecycle.startAuth`: when an interactive flow's background
 * `source.start()` fails AFTER the auth URL was returned (the token
 * exchange / reconnect throws once the user resumes), the failure must be
 * logged and the Connection moved to `dead` (+ lastError) — not swallowed,
 * leaving it stuck in `pending_auth` ("Connecting…") forever.
 *
 * Drive the real `startAuth` against a mock authorization server that:
 *   - 401s `/mcp` (triggers OAuth),
 *   - serves DCR + discovery,
 *   - returns a NON-redirect `/authorize` (200 login page) so the
 *     provider's redirect-probe falls through to the interactive branch,
 *   - then FAILS `/token` (400 invalid_grant) on resume.
 *
 * Integration tier: real `Bun.serve`, real SDK OAuth handshake.
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
      // The exchange fails — this is the failure we want surfaced.
      if (url.pathname === "/token" && req.method === "POST") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      // Never issues a usable token → always unauthorized.
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

const WS = "ws_test";
const SERVER = "interactive-fail-test";

describe("lifecycle.startAuth — interactive-flow failure is surfaced, not swallowed", () => {
  let workDir: string;
  let mock: MockAS;
  let lifecycle: BundleLifecycleManager;
  let sink: CapturingSink;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-startauth-interactive-"));
    mock = startMockAuthServer();
    sink = new CapturingSink();
    lifecycle = new BundleLifecycleManager(sink, undefined);
    const ref: BundleRef = { url: `${mock.base}/mcp`, serverName: SERVER, oauthScope: "workspace" };
    const instance: BundleInstance = {
      serverName: SERVER,
      bundleName: ref.url,
      version: "remote",
      state: "starting",
      trustScore: null,
      ui: null,
      briefing: null,
      httpProxy: null,
      protected: false,
      type: "plain",
      wsId: WS,
      oauthScope: "workspace",
      ref,
    };
    // biome-ignore lint/suspicious/noExplicitAny: reach into the private instance map the same way the sibling unit harness does.
    (lifecycle as any).instances.set(`${SERVER}|${WS}`, instance);
  });

  afterEach(() => {
    _clearAll();
    mock.stop();
  });

  it("a failed token exchange after the auth URL is returned → Connection 'dead' with lastError (not stuck pending_auth)", async () => {
    const { authorizationUrl } = await lifecycle.startAuth(SERVER, WS, WORKSPACE_PRINCIPAL_ID, {
      workDir,
      callbackUrl: `${mock.base}/callback`,
      allowInsecureRemotes: true,
    });

    // Interactive flow opened: the connector is parked in pending_auth.
    const conn = () => lifecycle.getInstance(SERVER, WS)?.connections?.get(WORKSPACE_PRINCIPAL_ID);
    expect(conn()?.state).toBe("pending_auth");

    // Simulate the user completing the authorization: resolve the pending
    // flow with a code. The background start() resumes, tries the token
    // exchange, and the mock /token returns 400 → start() rejects.
    const state = new URL(authorizationUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    expect(resolveWithCode(state as string, "mock-auth-code")).toBe(true);

    // Poll until the background start() settles into the surfaced failure.
    const deadline = Date.now() + 8000;
    while (conn()?.state !== "dead" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    // The fix: surfaced, not swallowed — and with a meaningful diagnostic.
    // The mock /token returns 400 invalid_grant, so the SDK throws
    // `InvalidGrantError` (whose `.message` is empty, hence the `.name`
    // fallback in startAuth's catch).
    expect(conn()?.state).toBe("dead");
    expect(conn()?.lastError).toBe("InvalidGrantError");
  }, 20_000);
});
