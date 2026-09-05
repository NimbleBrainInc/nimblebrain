/**
 * Boot-time Connection seeding must probe credentials under the runtime's
 * resolved work directory, not `defaultWorkDir()`.
 *
 * The two coincide whenever `NB_WORK_DIR` is set — which is every container,
 * since the image sets it. They diverge exactly when an operator sets `workDir`
 * in `nimblebrain.json` and leaves `NB_WORK_DIR` unset, which is the bare-metal
 * self-host shape. Probing the wrong root finds no tokens and seeds
 * `not_authenticated` for every remote connector at boot, however many are
 * actually connected — and since a re-connect is admin-gated, a member then
 * hits a hard 403 on a connector that is already working.
 *
 * Each case writes tokens under one root, points `NB_WORK_DIR` at the other,
 * and asserts which state the probe decides on. The third case pins the
 * direction: a probe reading `defaultWorkDir()` passes the first two by
 * coincidence and fails only that one.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../../src/bundles/lifecycle.ts";
import type { BundleRef } from "../../../src/bundles/types.ts";
import { legacyMcpOAuthDir, McpOAuthRecords } from "../../../src/tools/mcp-oauth-records.ts";
import {
  installTestCredentialStore,
  resetTestCredentialStore,
} from "../../helpers/credential-store.ts";

const WS = "ws_probe";
const SERVER = "remote-thing";

let configuredWorkDir: string;
let defaultishWorkDir: string;
let priorEnv: string | undefined;

beforeEach(() => {
  configuredWorkDir = mkdtempSync(join(tmpdir(), "nb-configured-"));
  defaultishWorkDir = mkdtempSync(join(tmpdir(), "nb-default-"));
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

function urlBundle(): BundleRef {
  return {
    type: "url",
    url: "https://example.invalid/mcp",
    transport: "http",
  } as BundleRef;
}

/**
 * Plant a pre-store `tokens.json` under `root`, marking the connector as
 * authenticated there.
 *
 * The legacy file is what still has a *root* to get wrong: the credential
 * store is constructed once, at the composition root, against the runtime's
 * resolved workDir, so the store leg of the probe cannot address the wrong
 * tree. The legacy import leg takes a `workDir` argument, and that argument is
 * what these cases pin.
 */
function writeTokens(root: string): void {
  const dir = legacyMcpOAuthDir(root, { type: "workspace", wsId: WS }, SERVER);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tokens.json"), JSON.stringify({ access_token: "t" }));
}

/**
 * Drive the private seeding path and capture the state it decides on.
 *
 * `recordConnectionStateChange` early-returns without a registered bundle
 * instance, so reading state back would test the instance registry rather than
 * the probe. Capturing the call tests the decision, which is the unit here.
 */
async function seededState(mgr: BundleLifecycleManager): Promise<string | undefined> {
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
      seedUrlConnectionState: (s: string, w: string, r: BundleRef) => Promise<void>;
    }
  ).seedUrlConnectionState(SERVER, WS, urlBundle());
  return seen;
}

test("seeds from the configured workDir, not NB_WORK_DIR", async () => {
  const mgr = new BundleLifecycleManager(new NoopEventSink(), undefined);
  mgr.setWorkDir(configuredWorkDir);

  // Connected: the tokens exist under the workDir the runtime resolved.
  writeTokens(configuredWorkDir);

  expect(await seededState(mgr)).toBe("running");
});

test("still seeds not_authenticated when no tokens exist anywhere", async () => {
  const mgr = new BundleLifecycleManager(new NoopEventSink(), undefined);
  mgr.setWorkDir(configuredWorkDir);

  expect(await seededState(mgr)).toBe("not_authenticated");
});

test("tokens under NB_WORK_DIR alone do not count as connected", async () => {
  // The inverse of the first case, and the one that pins the direction: a
  // probe reading `defaultWorkDir()` would call this connected. It is not —
  // nothing the runtime writes lives there under this config.
  const mgr = new BundleLifecycleManager(new NoopEventSink(), undefined);
  mgr.setWorkDir(configuredWorkDir);

  writeTokens(defaultishWorkDir);

  expect(await seededState(mgr)).toBe("not_authenticated");
});

test("tokens already in the credential store seed running with no legacy file", async () => {
  const mgr = new BundleLifecycleManager(new NoopEventSink(), undefined);
  mgr.setWorkDir(configuredWorkDir);

  await new McpOAuthRecords({
    owner: { type: "workspace", wsId: WS },
    serverName: SERVER,
    workDir: configuredWorkDir,
  }).write("tokens", { access_token: "t" });

  expect(await seededState(mgr)).toBe("running");
});
