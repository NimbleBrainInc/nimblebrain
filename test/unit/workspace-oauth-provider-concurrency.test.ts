import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";

/**
 * Concurrency contract for `WorkspaceOAuthProvider`.
 *
 * The MCP SDK's HTTP transport opens a connection with multiple parallel
 * requests (POST initialize, POST initialized notification, GET for SSE
 * stream). When OAuth is required, EACH 401 independently invokes `auth()`
 * on the SAME provider instance. That means `clientInformation()`,
 * `state()`, `saveCodeVerifier()`, `saveClientInformation()`, and
 * `redirectToAuthorization()` can all be called from multiple chains
 * concurrently in one logical Connect.
 *
 * Pre-coalesce, each chain generated its own (state, verifier, client_id,
 * URL); disk + cache held whoever wrote last; the user opened whichever URL
 * was returned first. The tuple desynchronized and the vendor returned
 * `invalid_code` on the exchange. These tests pin the invariant the fix
 * enforces: regardless of how many concurrent `auth()` chains run, the
 * provider exposes ONE coherent (state, verifier, client_id, captured URL)
 * tuple — same state, same verifier on disk, same DCR client, same URL
 * captured for the user — so the exchange always uses the same tuple the
 * vendor stored.
 *
 * If any of these break, the production failure mode returns:
 * `{"error":"invalid_code"}` on every Connect.
 */

const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";

function makeProvider(
  workDir: string,
  onInteractiveAuthRequired?: (url: string) => void,
): WorkspaceOAuthProvider {
  const provider = new WorkspaceOAuthProvider({
    owner: { type: "workspace", wsId: "ws_test" },
    serverName: "test-srv",
    workDir,
    callbackUrl: CALLBACK,
    ...(onInteractiveAuthRequired ? { onInteractiveAuthRequired } : {}),
  });
  // The redirectToAuthorization coalesce tests exercise the interactive branch,
  // now gated to user-initiated flows. Arm it so the branch is reachable.
  provider.setInteractiveAuthAllowed(true);
  return provider;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Builds an authorize URL with the given client_id and PKCE verifier, as
 * the SDK's `startAuthorization` would for this provider. Used to simulate
 * what each concurrent SDK `auth()` chain hands to `redirectToAuthorization`.
 */
function buildAuthUrl(opts: { clientId: string; state: string; verifier: string }): URL {
  const url = new URL("https://example.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("code_challenge", pkceChallenge(opts.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", CALLBACK);
  url.searchParams.set("state", opts.state);
  return url;
}

describe("WorkspaceOAuthProvider — concurrent auth() coalesce", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-oauth-concurrency-test-"));
  });

  it("state() returns the same value across concurrent callers", () => {
    const p = makeProvider(workDir);
    // `state()` is synchronous; concurrent invocations within one tick all
    // observe the FIRST call's pendingFlow and return its currentState.
    const states = [p.state(), p.state(), p.state(), p.state()];
    expect(new Set(states).size).toBe(1);
  });

  it("saveCodeVerifier — first writer wins; subsequent concurrent writes no-op", async () => {
    const p = makeProvider(workDir);
    p.state(); // create pendingFlow
    // Three concurrent saves with different verifiers — only the first
    // should land on disk; the rest are no-ops so the verifier paired
    // with the captured URL stays on disk.
    await Promise.all([
      p.saveCodeVerifier("verifier-A"),
      p.saveCodeVerifier("verifier-B"),
      p.saveCodeVerifier("verifier-C"),
    ]);
    expect(await p.codeVerifier()).toBe("verifier-A");
  });

  it("saveClientInformation — first writer wins; subsequent DCRs do not overwrite", async () => {
    const p = makeProvider(workDir);
    const a: OAuthClientInformationFull = { client_id: "client-A", redirect_uris: [CALLBACK] };
    const b: OAuthClientInformationFull = { client_id: "client-B", redirect_uris: [CALLBACK] };
    const c: OAuthClientInformationFull = { client_id: "client-C", redirect_uris: [CALLBACK] };
    await Promise.all([
      p.saveClientInformation(a),
      p.saveClientInformation(b),
      p.saveClientInformation(c),
    ]);
    const onDisk = JSON.parse(readFileSync(join(workDir, "workspaces", "ws_test", "credentials", "mcp-oauth", "test-srv", "client.json"), "utf8"));
    expect(onDisk.client_id).toBe("client-A");
    const fresh = makeProvider(workDir);
    expect((await fresh.clientInformation())?.client_id).toBe("client-A");
  });

  it("clientInformation() — awaiting callers unblock when abortSignal fires (liveness, no deadlock)", async () => {
    // Pre-fix: a concurrent caller awaiting `dcrInFlight` would hang
    // forever if the first caller's DCR threw before reaching
    // `saveClientInformation` (vendor 4xx, network drop, abort). The
    // abortSignal subscription releases the deferred so awaiters proceed
    // through the SDK's natural failure path.
    const controller = new AbortController();
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "test-srv",
      workDir,
      callbackUrl: CALLBACK,
      abortSignal: controller.signal,
    });
    // First caller claims the in-flight DCR slot
    expect(await p.clientInformation()).toBeUndefined();
    // Second caller now awaits
    const secondPromise = p.clientInformation();
    // Abort before saveClientInformation is ever called
    controller.abort();
    // Second caller resolves to undefined rather than hanging
    expect(await secondPromise).toBeUndefined();
  });

  it("clientInformation() — does NOT claim the slot when abortSignal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const p = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: "ws_test" },
      serverName: "test-srv",
      workDir,
      callbackUrl: CALLBACK,
      abortSignal: controller.signal,
    });
    // Caller gets undefined, but no in-flight slot is claimed (nothing
    // to seed — we're aborting, the broader auth() chain will fail).
    expect(await p.clientInformation()).toBeUndefined();
    // A subsequent caller is also free to do its own DCR rather than
    // awaiting a stale deferred.
    expect(await p.clientInformation()).toBeUndefined();
  });

  it("clientInformation() — concurrent callers awaiting a fresh DCR all get the first save's value", async () => {
    const p = makeProvider(workDir);
    // First caller sees the DCR slot empty, returns undefined (SDK would
    // do DCR), and claims the in-flight slot. Subsequent callers find the
    // slot held and await its result.
    const first = await p.clientInformation();
    expect(first).toBeUndefined();
    const waiters = Promise.all([p.clientInformation(), p.clientInformation()]);
    // First caller's saveClientInformation resolves the in-flight promise.
    await p.saveClientInformation({ client_id: "first-dcr", redirect_uris: [CALLBACK] });
    const [a, b] = await waiters;
    expect(a?.client_id).toBe("first-dcr");
    expect(b?.client_id).toBe("first-dcr");
  });

  it(
    "redirectToAuthorization — only the chain whose PKCE matches the disk verifier captures the URL",
    async () => {
      const captured: string[] = [];
      const p = makeProvider(workDir, (url) => captured.push(url));
      const state = p.state();
      // Simulate two SDK auth() chains: each generates its own verifier
      // and an authorize URL whose code_challenge is SHA256(its verifier).
      const vA = "verifier-A-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const vB = "verifier-B-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const urlA = buildAuthUrl({ clientId: "client-X", state, verifier: vA });
      const urlB = buildAuthUrl({ clientId: "client-X", state, verifier: vB });

      // Chain A saves its verifier first → claims the verifier slot.
      await p.saveCodeVerifier(vA);
      await p.saveCodeVerifier(vB); // coalesced no-op; disk stays vA

      // Both chains call redirectToAuthorization. Each throws (the headless
      // probe is off + we use the interactive branch's UnauthorizedError
      // exit). Only the chain whose URL's challenge matches the saved
      // verifier should reach the onInteractiveAuthRequired callback.
      await expect(p.redirectToAuthorization(urlB)).rejects.toThrow();
      await expect(p.redirectToAuthorization(urlA)).rejects.toThrow();

      // Exactly one URL captured — the one whose challenge == SHA256(disk verifier).
      expect(captured.length).toBe(1);
      const capturedUrl = new URL(captured[0]!);
      expect(capturedUrl.searchParams.get("code_challenge")).toBe(pkceChallenge(vA));

      // And the disk verifier produces that exact challenge — the tuple is
      // coherent end-to-end (this is what makes the exchange succeed).
      expect(pkceChallenge(await p.codeVerifier())).toBe(
        capturedUrl.searchParams.get("code_challenge"),
      );
    },
  );

  it("end-to-end: N concurrent chains converge to one coherent (state, verifier, client_id, URL) tuple", async () => {
    const captured: string[] = [];
    const p = makeProvider(workDir, (url) => captured.push(url));

    // Simulate 3 concurrent SDK auth() chains, each doing the full sequence
    // (DCR + state + saveCodeVerifier + redirectToAuthorization). All in
    // parallel — interleaving is up to the scheduler.
    const runChain = async (label: string): Promise<void> => {
      // Each chain: DCR (or coalesce), then state(), then save its verifier,
      // then try to redirect.
      const existing = await p.clientInformation();
      if (!existing) {
        await p.saveClientInformation({
          client_id: `client-${label}`,
          redirect_uris: [CALLBACK],
        });
      }
      const s = p.state();
      const verifier = `verifier-${label}-padding-padding-padding-padding`;
      await p.saveCodeVerifier(verifier);
      try {
        await p.redirectToAuthorization(buildAuthUrl({ clientId: `client-${label}`, state: s, verifier }));
      } catch {
        // Expected — all chains throw UnauthorizedError; the matching one
        // throws after capture, the others throw before.
      }
    };

    await Promise.all([runChain("A"), runChain("B"), runChain("C")]);

    // Exactly one URL captured — the user only ever sees one auth URL.
    expect(captured.length).toBe(1);
    const capturedUrl = new URL(captured[0]!);

    // The captured URL's PKCE challenge matches the disk verifier — what
    // makes the eventual exchange succeed.
    expect(capturedUrl.searchParams.get("code_challenge")).toBe(
      pkceChallenge(await p.codeVerifier()),
    );

    // The captured URL's client_id matches the disk client.json — what
    // makes the vendor accept the exchange (code was issued for THIS client).
    const diskClient = JSON.parse(readFileSync(join(workDir, "workspaces", "ws_test", "credentials", "mcp-oauth", "test-srv", "client.json"), "utf8"));
    expect(capturedUrl.searchParams.get("client_id")).toBe(diskClient.client_id);
  });
});
