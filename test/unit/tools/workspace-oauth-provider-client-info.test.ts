import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  BackgroundReauthRequiredError,
  WorkspaceOAuthProvider,
} from "../../../src/tools/workspace-oauth-provider.ts";

/**
 * Regression coverage for the OAuth redirect_uri-drift fix:
 *
 *   - A stored DCR client whose registered redirect_uri has drifted from the
 *     current callback is HONORED on the silent/background path (not discarded)
 *     — discarding it orphaned the refresh token and forced a headless
 *     interactive flow that timed out (the bundle.crashed loop).
 *   - A structurally-corrupt client (no usable redirect_uris) is still dropped.
 *   - A user-initiated interactive flow on a drifted host DOES re-register.
 *   - A background start that hits an interactive requirement flips to
 *     reauth_required and fails fast instead of blocking on a browser flow.
 */

const WS_ID = "ws_abc123";
const SERVER = "com-test-mcp";
const CURRENT_CALLBACK = "https://new.example.com/v1/mcp-auth/callback";
const DRIFTED_REDIRECT = "https://old.example.com/v1/mcp-auth/callback";

let workDir: string;
let dataDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "nb-oauth-provider-"));
  // Mirror the provider's legacy dataDir layout.
  dataDir = join(workDir, "workspaces", WS_ID, "credentials", "mcp-oauth", SERVER);
  await mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeProvider(): WorkspaceOAuthProvider {
  return new WorkspaceOAuthProvider({
    owner: { type: "workspace", wsId: WS_ID },
    serverName: SERVER,
    workDir,
    callbackUrl: CURRENT_CALLBACK,
  });
}

async function writeClientJson(redirectUris: unknown): Promise<void> {
  await writeFile(
    join(dataDir, "client.json"),
    JSON.stringify({ client_id: "cid-stored", redirect_uris: redirectUris }),
  );
}

describe("WorkspaceOAuthProvider.clientInformation — redirect_uri drift", () => {
  it("test_clientInformation_drifted_redirect_is_honored_not_discarded", async () => {
    await writeClientJson([DRIFTED_REDIRECT]);
    const provider = makeProvider();

    const info = await provider.clientInformation();

    // Stored client is returned (refresh reuses its client_id) ...
    expect(info?.client_id).toBe("cid-stored");
    // ... and the on-disk registration is preserved, not orphaned.
    expect(existsSync(join(dataDir, "client.json"))).toBe(true);
  });

  it("test_clientInformation_corrupt_redirect_uris_is_discarded", async () => {
    await writeClientJson([]); // empty array → structurally unusable
    const provider = makeProvider();

    const info = await provider.clientInformation();

    expect(info).toBeUndefined(); // forces a fresh DCR
    expect(existsSync(join(dataDir, "client.json"))).toBe(false);
  });

  it("test_clientInformation_drift_with_interactive_armed_reregisters", async () => {
    await writeClientJson([DRIFTED_REDIRECT]);
    const provider = makeProvider();
    provider.setInteractiveAuthAllowed(true); // user-initiated reauth

    const info = await provider.clientInformation();

    // Re-register against the current host: drop the stale client, return
    // undefined so the SDK runs a fresh DCR.
    expect(info).toBeUndefined();
    expect(existsSync(join(dataDir, "client.json"))).toBe(false);
  });

  it("test_redirectUrl_honors_stored_registration_after_load", async () => {
    await writeClientJson([DRIFTED_REDIRECT]);
    const provider = makeProvider();

    await provider.clientInformation(); // loads + caches the stored client

    // The redirect_uri presented to the AS is the registered one, not the
    // recomputed callback.
    expect(provider.redirectUrl).toBe(DRIFTED_REDIRECT);
  });

  it("test_redirectUrl_falls_back_to_callback_without_stored_client", () => {
    const provider = makeProvider();
    expect(provider.redirectUrl).toBe(CURRENT_CALLBACK);
  });
});

describe("WorkspaceOAuthProvider.redirectToAuthorization — background gate", () => {
  it("test_redirectToAuthorization_background_flips_reauth_and_fails_fast", async () => {
    let authLostFired = false;
    const provider = new WorkspaceOAuthProvider({
      owner: { type: "workspace", wsId: WS_ID },
      serverName: SERVER,
      workDir,
      callbackUrl: CURRENT_CALLBACK,
      onAuthLost: () => {
        authLostFired = true;
      },
      // interactiveAuthAllowed defaults false (background / liveness context);
      // headlessAuthProbe false so we reach the interactive branch directly.
    });

    provider.state(); // establish the pending flow

    await expect(
      provider.redirectToAuthorization(new URL("https://vendor.example.com/authorize?state=abc")),
    ).rejects.toBeInstanceOf(BackgroundReauthRequiredError);

    // The connection is flagged for reauth instead of blocking a browser flow.
    expect(authLostFired).toBe(true);
  });
});
