import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InteractiveOAuthNotSupportedError,
  WorkspaceOAuthProvider,
} from "../../src/tools/workspace-oauth-provider.ts";

const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";

function makeProvider(workDir: string, serverName = "test-srv"): WorkspaceOAuthProvider {
  return new WorkspaceOAuthProvider({
    wsId: "ws_test",
    serverName,
    workDir,
    callbackUrl: CALLBACK,
  });
}

describe("WorkspaceOAuthProvider", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-test-"));
  });

  it("roundtrips client information via files", async () => {
    const p = makeProvider(workDir);
    const info: OAuthClientInformationFull = {
      client_id: "cid-123",
      redirect_uris: [CALLBACK],
    };
    await p.saveClientInformation(info);

    const read = await p.clientInformation();
    expect(read).toEqual(info);

    // Second provider instance (no in-memory cache) should see the file
    const p2 = makeProvider(workDir);
    const read2 = await p2.clientInformation();
    expect(read2).toEqual(info);
  });

  it("roundtrips tokens via files", async () => {
    const p = makeProvider(workDir);
    const tokens: OAuthTokens = {
      access_token: "acc",
      token_type: "Bearer",
      refresh_token: "ref",
      expires_in: 3600,
    };
    await p.saveTokens(tokens);

    const p2 = makeProvider(workDir);
    const read = await p2.tokens();
    expect(read).toEqual(tokens);
  });

  it("headless flow: authorize endpoint 302 to our callback with code resolves pending flow", async () => {
    // Stand up a mock authorize endpoint that behaves like Reboot's Anonymous:
    // 302 straight back to the client's redirect_uri with ?code=anonymous&state=<state>.
    const mockAuthServer = Bun.serve({
      port: 0,
      fetch(req: Request) {
        const u = new URL(req.url);
        const state = u.searchParams.get("state") ?? "";
        const redirectUri = u.searchParams.get("redirect_uri") ?? CALLBACK;
        const target = new URL(redirectUri);
        target.searchParams.set("code", "anonymous");
        target.searchParams.set("state", state);
        return new Response(null, { status: 302, headers: { location: target.toString() } });
      },
    });
    try {
      const authUrl = new URL(`http://localhost:${mockAuthServer.port}/authorize`);
      const p = makeProvider(workDir);
      const state = p.state();
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("redirect_uri", CALLBACK);
      const pending = p.awaitPendingFlow();

      await p.redirectToAuthorization(authUrl);
      await expect(pending).resolves.toBe("anonymous");
    } finally {
      mockAuthServer.stop(true);
    }
  });

  it("headless flow: multi-hop same-origin redirects eventually hitting our callback (Reboot pattern)", async () => {
    // Mimics Reboot: /authorize 302s to /intermediate, which 302s to our callback.
    const mockAuthServer = Bun.serve({
      port: 0,
      fetch(req: Request) {
        const u = new URL(req.url);
        if (u.pathname === "/authorize") {
          const state = u.searchParams.get("state") ?? "";
          const redirectUri = u.searchParams.get("redirect_uri") ?? CALLBACK;
          // Hop 1: redirect to our own /intermediate with an internal token
          const interm = new URL(`http://localhost:${mockAuthServer.port}/intermediate`);
          interm.searchParams.set("internal_token", "reboot-jwt");
          interm.searchParams.set("mcp_state", state);
          interm.searchParams.set("mcp_redirect_uri", redirectUri);
          return new Response(null, {
            status: 302,
            headers: { location: interm.toString() },
          });
        }
        if (u.pathname === "/intermediate") {
          // Hop 2: redirect to the client's redirect_uri with the real code
          const mcpState = u.searchParams.get("mcp_state") ?? "";
          const mcpRedirect = u.searchParams.get("mcp_redirect_uri") ?? CALLBACK;
          const target = new URL(mcpRedirect);
          target.searchParams.set("code", "anonymous");
          target.searchParams.set("state", mcpState);
          return new Response(null, {
            status: 302,
            headers: { location: target.toString() },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const authUrl = new URL(`http://localhost:${mockAuthServer.port}/authorize`);
      const p = makeProvider(workDir);
      const state = p.state();
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("redirect_uri", CALLBACK);
      const pending = p.awaitPendingFlow();

      await p.redirectToAuthorization(authUrl);
      await expect(pending).resolves.toBe("anonymous");
    } finally {
      mockAuthServer.stop(true);
    }
  });

  it("interactive flow: authorize endpoint 302s to a login page throws InteractiveOAuthNotSupportedError", async () => {
    // Mock authorize endpoint that redirects to a non-self-target login page
    // (how Granola / Claude.ai / real OAuth providers behave).
    const mockAuthServer = Bun.serve({
      port: 0,
      fetch(_req: Request) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://login.example.com/authenticate" },
        });
      },
    });
    try {
      const authUrl = new URL(`http://localhost:${mockAuthServer.port}/authorize`);
      const p = makeProvider(workDir);
      const state = p.state();
      authUrl.searchParams.set("state", state);
      const pending = p.awaitPendingFlow();
      const pendingSettled = pending.catch((err) => err);

      await expect(p.redirectToAuthorization(authUrl)).rejects.toBeInstanceOf(
        InteractiveOAuthNotSupportedError,
      );
      expect(await pendingSettled).toBeInstanceOf(InteractiveOAuthNotSupportedError);
    } finally {
      mockAuthServer.stop(true);
    }
  });

  it("interactive flow: authorize endpoint 200s with login form throws InteractiveOAuthNotSupportedError", async () => {
    // Providers that return 200 with an HTML login form (not a 302) are also
    // interactive from our perspective — we can't extract a code.
    const mockAuthServer = Bun.serve({
      port: 0,
      fetch(_req: Request) {
        return new Response("<html>login form</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });
    try {
      const authUrl = new URL(`http://localhost:${mockAuthServer.port}/authorize`);
      const p = makeProvider(workDir);
      const state = p.state();
      authUrl.searchParams.set("state", state);
      const pending = p.awaitPendingFlow();
      const pendingSettled = pending.catch((err) => err);

      await expect(p.redirectToAuthorization(authUrl)).rejects.toBeInstanceOf(
        InteractiveOAuthNotSupportedError,
      );
      expect(await pendingSettled).toBeInstanceOf(InteractiveOAuthNotSupportedError);
    } finally {
      mockAuthServer.stop(true);
    }
  });

  it("verifier roundtrip + codeVerifier missing throws", async () => {
    const p = makeProvider(workDir);
    await p.saveCodeVerifier("pkce-verifier-xyz");
    expect(await p.codeVerifier()).toBe("pkce-verifier-xyz");

    await p.invalidateCredentials("verifier");
    await expect(p.codeVerifier()).rejects.toThrow(/verifier missing/);
  });

  it("invalidateCredentials removes tokens but keeps client info on 'tokens' scope", async () => {
    const p = makeProvider(workDir);
    await p.saveClientInformation({ client_id: "cid", redirect_uris: [CALLBACK] });
    await p.saveTokens({ access_token: "a", token_type: "Bearer" });

    await p.invalidateCredentials("tokens");

    const p2 = makeProvider(workDir);
    expect(await p2.tokens()).toBeUndefined();
    expect(await p2.clientInformation()).toBeDefined();
  });

  it("files are written under <workDir>/workspaces/<wsId>/credentials/mcp-oauth/<serverName>/", async () => {
    const p = makeProvider(workDir, "my-server");
    const tokens: OAuthTokens = { access_token: "a", token_type: "Bearer" };
    await p.saveTokens(tokens);

    const expectedPath = join(
      workDir,
      "workspaces",
      "ws_test",
      "credentials",
      "mcp-oauth",
      "my-server",
      "tokens.json",
    );
    const onDisk = JSON.parse(readFileSync(expectedPath, "utf-8"));
    expect(onDisk).toEqual(tokens);
  });

  it("awaitPendingFlow without state() throws (no active flow)", async () => {
    const p = makeProvider(workDir);
    await expect(p.awaitPendingFlow()).rejects.toThrow(/no active flow/i);
  });
});
