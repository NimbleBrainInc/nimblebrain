import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { _clearAll } from "../../src/tools/oauth-flow-registry.ts";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";

// The redirect-probe is a headless-only optimization. For a normal
// interactive provider (Granola, Claude.ai, …) it MUST NOT run: fetching
// `/authorize` server-side spins up a vendor authorization session bound to
// our PKCE challenge before the user acts, and the vendor then rejects the
// user's real code at exchange (`invalid_code`). This pins the gate: probe
// iff `headlessAuthProbe`.

const AUTH_URL =
  "https://mcp-auth.granola.example/oauth2/authorize?response_type=code&client_id=c1&code_challenge=ch&code_challenge_method=S256&state=st_abc&redirect_uri=https%3A%2F%2Fhq.example%2Fv1%2Fmcp-auth%2Fcallback";

function makeProvider(
  workDir: string,
  headlessAuthProbe: boolean,
  onInteractiveAuthRequired: (url: string) => void,
): WorkspaceOAuthProvider {
  return new WorkspaceOAuthProvider({
    owner: { type: "workspace", wsId: "ws_test" },
    serverName: "granola-test",
    workDir,
    callbackUrl: "https://hq.example/v1/mcp-auth/callback",
    allowInsecureRemotes: true,
    headlessAuthProbe,
    onInteractiveAuthRequired,
  });
}

describe("WorkspaceOAuthProvider — redirect-probe is gated on headlessAuthProbe", () => {
  let workDir: string;
  let origFetch: typeof fetch;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "nb-probe-gate-"));
    origFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    _clearAll();
  });

  it("interactive (default, headlessAuthProbe=false): does NOT fetch /authorize; goes straight to the interactive branch", async () => {
    const fetchSpy = mock(async () => new Response("login page", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    let capturedUrl = "";
    const p = makeProvider(workDir, false, (u) => {
      capturedUrl = u;
    });
    p.state(); // initializes pendingFlow (the SDK calls this before redirect)

    // Interactive branch registers the flow + fires the callback + throws.
    await expect(p.redirectToAuthorization(new URL(AUTH_URL))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    // The crux: no server-side authorize probe happened.
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(capturedUrl).toContain("/oauth2/authorize");
  });

  it("headless (headlessAuthProbe=true): DOES probe /authorize server-side", async () => {
    const fetchSpy = mock(async () => new Response("login page", { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const p = makeProvider(workDir, true, () => {});
    p.state();

    // 200 from the probe → not headless → falls through to interactive (throws),
    // but the probe fetch DID fire.
    await expect(p.redirectToAuthorization(new URL(AUTH_URL))).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
