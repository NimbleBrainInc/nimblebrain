import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  InteractiveOAuthNotSupportedError,
  WorkspaceOAuthProvider,
} from "../../src/tools/workspace-oauth-provider.ts";

// Moved from `test/unit/` per AGENTS.md: any test that calls Bun.serve()
// belongs in integration. These cases exercise the provider's authorize-
// redirect probe against a real HTTP target on localhost; SSRF validation
// is explicitly opt-in via `allowInsecureRemotes: true` in each makeProvider
// call so the loopback targets aren't blocked.

const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";

function makeProvider(
  workDir: string,
  overrides: { serverName?: string; callbackUrl?: string; allowInsecureRemotes?: boolean } = {},
): WorkspaceOAuthProvider {
  return new WorkspaceOAuthProvider({
    wsId: "ws_test",
    serverName: overrides.serverName ?? "test-srv",
    workDir,
    callbackUrl: overrides.callbackUrl ?? CALLBACK,
    // Most tests target localhost:<random> via Bun.serve, which validateBundleUrl
    // blocks by default. Each test opts in explicitly; the "SSRF block" test
    // flips this off to assert the blocker works.
    allowInsecureRemotes: overrides.allowInsecureRemotes ?? true,
  });
}

describe("WorkspaceOAuthProvider — authorize redirect probe (headless)", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-integ-"));
  });

  it("authorize endpoint 302 to our callback with code resolves pending flow", async () => {
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

  it("multi-hop same-origin redirects eventually hitting our callback (Reboot pattern)", async () => {
    const mockAuthServer = Bun.serve({
      port: 0,
      fetch(req: Request) {
        const u = new URL(req.url);
        if (u.pathname === "/authorize") {
          const state = u.searchParams.get("state") ?? "";
          const redirectUri = u.searchParams.get("redirect_uri") ?? CALLBACK;
          const interm = new URL(`http://localhost:${mockAuthServer.port}/intermediate`);
          interm.searchParams.set("internal_token", "reboot-jwt");
          interm.searchParams.set("mcp_state", state);
          interm.searchParams.set("mcp_redirect_uri", redirectUri);
          return new Response(null, { status: 302, headers: { location: interm.toString() } });
        }
        if (u.pathname === "/intermediate") {
          const mcpState = u.searchParams.get("mcp_state") ?? "";
          const mcpRedirect = u.searchParams.get("mcp_redirect_uri") ?? CALLBACK;
          const target = new URL(mcpRedirect);
          target.searchParams.set("code", "anonymous");
          target.searchParams.set("state", mcpState);
          return new Response(null, { status: 302, headers: { location: target.toString() } });
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

  it("callback self-match tolerates trailing slash and explicit default port", async () => {
    // Reviewer-called-out regression guard: the old self-match was a raw
    // string === comparison that false-negative'd on trivial URL variants.
    // Here the CONFIGURED callbackUrl has a trailing `/`, and the
    // authorize server echoes an explicit default-port form back. Both
    // should be treated as the same endpoint.
    const mockAuthServer = Bun.serve({
      port: 0,
      fetch(req: Request) {
        const u = new URL(req.url);
        const state = u.searchParams.get("state") ?? "";
        // Return the callback URL with a trailing slash stripped AND no
        // explicit default port — i.e., a cosmetic variant of the
        // configured callback.
        const target = new URL("http://localhost:27247/v1/mcp-auth/callback");
        target.searchParams.set("code", "anonymous");
        target.searchParams.set("state", state);
        return new Response(null, { status: 302, headers: { location: target.toString() } });
      },
    });
    try {
      // Configured callback has a trailing slash.
      const p = makeProvider(workDir, {
        callbackUrl: "http://LOCALHOST:27247/v1/mcp-auth/callback/",
      });
      const state = p.state();
      const authUrl = new URL(`http://localhost:${mockAuthServer.port}/authorize`);
      authUrl.searchParams.set("state", state);
      const pending = p.awaitPendingFlow();

      await p.redirectToAuthorization(authUrl);
      await expect(pending).resolves.toBe("anonymous");
    } finally {
      mockAuthServer.stop(true);
    }
  });
});

describe("WorkspaceOAuthProvider — authorize redirect probe (interactive)", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-integ-"));
  });

  it("302 to a non-self-target login page throws InteractiveOAuthNotSupportedError", async () => {
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

  it("200 with a login form (no redirect) throws InteractiveOAuthNotSupportedError", async () => {
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
});

describe("WorkspaceOAuthProvider — SSRF defense", () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-integ-"));
  });

  it("blocks a loopback authorize URL when allowInsecureRemotes is false", async () => {
    // Mock server that would gladly 302-to-metadata if reached — we should
    // never reach it because validateBundleUrl blocks the initial hop.
    const mockAuthServer = Bun.serve({
      port: 0,
      fetch(_req: Request) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      },
    });
    try {
      const authUrl = new URL(`http://localhost:${mockAuthServer.port}/authorize`);
      const p = makeProvider(workDir, { allowInsecureRemotes: false });
      p.state();
      const pending = p.awaitPendingFlow();
      const pendingSettled = pending.catch((err) => err);

      const thrown = await p.redirectToAuthorization(authUrl).catch((err) => err);
      // SSRF block surfaces as an `[workspace-oauth-provider] SSRF block …`
      // error rather than the generic "interactive not supported" —
      // operators see the real cause.
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/\[workspace-oauth-provider\] SSRF block/);
      // The provider-local deferred is also rejected so awaitPendingFlow
      // returns the same error (caller never hangs on a dead flow).
      expect((await pendingSettled) as Error).toBeInstanceOf(Error);
    } finally {
      mockAuthServer.stop(true);
    }
  });

  it("blocks a redirect-chain hop that points at cloud metadata", async () => {
    // Authorize endpoint redirects to AWS IMDS. With allowInsecureRemotes=true
    // for localhost, the initial hop passes, but the NEXT hop (169.254...)
    // is non-loopback private and must be blocked regardless.
    const mockAuthServer = Bun.serve({
      port: 0,
      fetch(_req: Request) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/iam" },
        });
      },
    });
    try {
      const authUrl = new URL(`http://localhost:${mockAuthServer.port}/authorize`);
      const p = makeProvider(workDir, { allowInsecureRemotes: true });
      p.state();
      const pending = p.awaitPendingFlow();
      const pendingSettled = pending.catch((err) => err);

      const thrown = await p.redirectToAuthorization(authUrl).catch((err) => err);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/\[workspace-oauth-provider\] SSRF block/);
      expect((await pendingSettled) as Error).toBeInstanceOf(Error);
    } finally {
      mockAuthServer.stop(true);
    }
  });
});

// Ensure the process's ref-counted handles from timers / pending flows don't
// keep test runner alive between suites.
afterAll(() => {
  // No-op; each `it` cleans up its own server. This hook exists so the
  // suite has an explicit teardown point for future additions.
});
