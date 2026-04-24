import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "bun:test";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { WorkspaceOAuthProvider } from "../../src/tools/workspace-oauth-provider.ts";

// Bun.serve-based cases (headless single-hop, headless multi-hop, interactive
// 302, interactive 200, SSRF block) live in
// `test/integration/workspace-oauth-provider.test.ts`, per AGENTS.md:
// "If a test calls Runtime.start(), startServer(), Bun.serve(), or
//  spawnSync(), it belongs in test/integration/."
// This unit file covers file-IO roundtrips and `awaitPendingFlow` guards
// that don't need a real HTTP target.

const CALLBACK = "http://localhost:27247/v1/mcp-auth/callback";

function makeProvider(workDir: string, serverName = "test-srv"): WorkspaceOAuthProvider {
  return new WorkspaceOAuthProvider({
    wsId: "ws_test",
    serverName,
    workDir,
    callbackUrl: CALLBACK,
  });
}

describe("WorkspaceOAuthProvider — file I/O roundtrips", () => {
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
