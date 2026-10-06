/**
 * Boot-time Connection seeding for a remote OAuth connector: which state the
 * probe decides on from the connection's OAuth records in the credential store.
 *
 * The runtime's configured workDir and `NB_WORK_DIR` are set apart so a probe
 * that resolved its own root instead of the runtime's would be visible.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { ConnectorLifecycleManager } from "../../../src/connectors/runtime/lifecycle.ts";
import type { ConnectorRef } from "../../../src/connectors/runtime/types.ts";
import { McpOAuthRecords } from "../../../src/tools/mcp-oauth-records.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../../helpers/credential-store.ts";
import { seedWorkspaceRoot } from "../../helpers/test-workspace.ts";

const WS = "ws_006049df791a1f50";
const SERVER = "remote-thing";

let configuredWorkDir: string;
let defaultishWorkDir: string;
let priorEnv: string | undefined;

beforeEach(() => {
  configuredWorkDir = mkdtempSync(join(tmpdir(), "nb-configured-"));
  seedWorkspaceRoot(configuredWorkDir, "ws_006049df791a1f50");
  defaultishWorkDir = mkdtempSync(join(tmpdir(), "nb-default-"));
  seedWorkspaceRoot(defaultishWorkDir, "ws_006049df791a1f50");
  installTestCredentialStore(configuredWorkDir);
  priorEnv = process.env.NB_WORK_DIR;
  // The divergence under test: `defaultWorkDir()` resolves here, the runtime's
  // configured workDir is elsewhere.
  process.env.NB_WORK_DIR = defaultishWorkDir;
});

afterEach(() => {
  resetTestCredentialStore();
  if (priorEnv === undefined) delete process.env.NB_WORK_DIR;
  else process.env.NB_WORK_DIR = priorEnv;
  rmSync(configuredWorkDir, { recursive: true, force: true });
  rmSync(defaultishWorkDir, { recursive: true, force: true });
});

function urlConnector(): ConnectorRef {
  return { url: "https://example.invalid/mcp", serverName: SERVER };
}

/**
 * Drive the private seeding path and capture the state it decides on.
 *
 * `recordConnectionStateChange` early-returns without a registered connector
 * instance, so reading state back would test the instance registry rather than
 * the probe. Capturing the call tests the decision, which is the unit here.
 */
async function seededState(
  mgr: ConnectorLifecycleManager,
  startError?: string,
): Promise<string | undefined> {
  let seen: string | undefined;
  (mgr as unknown as { recordConnectionStateChange: unknown }).recordConnectionStateChange = (
    _server: string,
    _ws: string,
    _principal: string,
    state: string,
  ): void => {
    seen = state;
  };
  await (
    mgr as unknown as {
      seedUrlConnectionState: (
        s: string,
        w: string,
        r: ConnectorRef,
        startError?: string,
      ) => Promise<void>;
    }
  ).seedUrlConnectionState(SERVER, WS, urlConnector(), startError);
  return seen;
}

test("still seeds not_authenticated when no tokens exist anywhere", async () => {
  const mgr = new ConnectorLifecycleManager(new NoopEventSink());
  mgr.setWorkDir(configuredWorkDir);

  expect(await seededState(mgr)).toBe("not_authenticated");
});

test("tokens in the credential store seed running", async () => {
  const mgr = new ConnectorLifecycleManager(new NoopEventSink());
  mgr.setWorkDir(configuredWorkDir);

  await new McpOAuthRecords({
    owner: { type: "workspace", wsId: WS },
    serverName: SERVER,
  }).write("tokens", { access_token: "t" });

  expect(await seededState(mgr)).toBe("running");
});

// ── auth_lost: a broken connection survives a restart ──────────────────
//
// The SDK deletes the rejected tokens on `invalid_grant`, so without the flag a
// connection whose credential was revoked boots exactly like one the user
// disconnected. The flag is what keeps amber "Reconnect" apart from a neutral
// "Not connected" across a deploy.

function records(): McpOAuthRecords {
  return new McpOAuthRecords({
    owner: { type: "workspace", wsId: WS },
    serverName: SERVER,
  });
}

test("test_seed_authLostWithoutTokens_seedsReauthRequired", async () => {
  const mgr = new ConnectorLifecycleManager(new NoopEventSink());
  mgr.setWorkDir(configuredWorkDir);
  await records().write("auth_lost", { at: "2026-01-01T00:00:00.000Z" });

  expect(await seededState(mgr)).toBe("reauth_required");
});

test("test_seed_authLostOnFailedBoot_seedsReauthRequiredNotDead", async () => {
  // The boot that discovers the rejection fails with it; that must still read
  // as reauth, not as an unreachable endpoint.
  const mgr = new ConnectorLifecycleManager(new NoopEventSink());
  mgr.setWorkDir(configuredWorkDir);
  await records().write("auth_lost", { at: "2026-01-01T00:00:00.000Z" });

  expect(await seededState(mgr, "reauthorization required")).toBe("reauth_required");
});

test("test_seed_authLostWithWorkingTokens_seedsRunning", async () => {
  // A refresh that failed with a server error leaves the tokens in place, and
  // a boot that starts with them is connected.
  const mgr = new ConnectorLifecycleManager(new NoopEventSink());
  mgr.setWorkDir(configuredWorkDir);
  await records().write("auth_lost", { at: "2026-01-01T00:00:00.000Z" });
  await records().write("tokens", { access_token: "t" });

  expect(await seededState(mgr)).toBe("running");
});

test("test_seed_failedBootWithoutAuthLost_seedsDead", async () => {
  const mgr = new ConnectorLifecycleManager(new NoopEventSink());
  mgr.setWorkDir(configuredWorkDir);

  expect(await seededState(mgr, "ECONNREFUSED")).toBe("dead");
});
