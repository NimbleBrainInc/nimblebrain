import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";

/**
 * Proves the `abortSignal` constructor option threads into the
 * redirect-probe loop's `fetch()`. Lifecycle's 15s `startAuth` race
 * aborts an `AbortController` whose signal we pass here — without
 * the threading, an unresponsive auth server's TCP read would
 * outlive the timeout by its full network deadline (often 30–60s).
 *
 * The test deliberately uses a server that NEVER responds (the
 * handler returns a Promise that never resolves). Without the abort
 * wiring, the `fetch()` call would hang for the full network
 * timeout. With it, aborting the signal terminates the read with a
 * recognizable error within ~100ms.
 */

const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";

describe("WorkspaceOAuthProvider — abortSignal threading", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-abort-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("aborts the redirect-probe fetch when the signal fires", async () => {
    // A server that accepts the connection but never responds —
    // simulates an unresponsive auth server that's holding the TCP
    // connection open without sending headers.
    const mockServer = Bun.serve({
      port: 0,
      fetch: () => new Promise(() => {}),
    });

    try {
      const controller = new AbortController();
      const provider = new WorkspaceOAuthProvider({
        owner: { type: "workspace", wsId: "ws_test" },
        serverName: "abort-test",
        workDir,
        callbackUrl: CALLBACK,
        allowInsecureRemotes: true,
        abortSignal: controller.signal,
      });

      const authUrl = new URL(`http://localhost:${mockServer.port}/authorize`);
      const state = provider.state();
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("redirect_uri", CALLBACK);

      // Fire the abort 100ms in. The fetch should reject very shortly
      // after that — proving the signal is consulted by fetch and the
      // probe loop unwinds promptly.
      const start = performance.now();
      setTimeout(() => controller.abort(), 100);

      await expect(provider.redirectToAuthorization(authUrl)).rejects.toThrow();
      const elapsed = performance.now() - start;
      // 1500ms gives generous buffer over the 100ms abort + abort
      // propagation. Without signal threading, this would hang for the
      // platform's default fetch timeout (multiple seconds).
      expect(elapsed).toBeLessThan(1500);
    } finally {
      mockServer.stop(true);
    }
  });

  it("works without abortSignal (backward compatible)", async () => {
    // Same hanging server, no signal — the test asserts the provider
    // doesn't throw on construction or break unrelated flows. We
    // start the call but don't await; just confirm the absence of a
    // signal doesn't fail-fast some new code path.
    const mockServer = Bun.serve({
      port: 0,
      fetch: () => new Promise(() => {}),
    });
    try {
      const provider = new WorkspaceOAuthProvider({
        owner: { type: "workspace", wsId: "ws_test" },
        serverName: "no-abort",
        workDir,
        callbackUrl: CALLBACK,
        allowInsecureRemotes: true,
        // no abortSignal
      });
      const authUrl = new URL(`http://localhost:${mockServer.port}/authorize`);
      const state = provider.state();
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("redirect_uri", CALLBACK);

      // Kick off the call but don't await it (would hang). Race against
      // a short delay; if the call rejected synchronously / immediately
      // for some reason that'd be a regression.
      const settled = await Promise.race([
        provider.redirectToAuthorization(authUrl).then(() => "resolved" as const, () => "rejected" as const),
        new Promise<"hung">((r) => setTimeout(() => r("hung"), 200)),
      ]);
      expect(settled).toBe("hung");
    } finally {
      mockServer.stop(true);
    }
  });
});
