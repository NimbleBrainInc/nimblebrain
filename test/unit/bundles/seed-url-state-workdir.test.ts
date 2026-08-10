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
import { workspaceOAuthDir } from "../../../src/bundles/oauth-tokens.ts";
import type { BundleRef } from "../../../src/bundles/types.ts";

const WS = "ws_probe";
const SERVER = "remote-thing";

let configuredWorkDir: string;
let defaultishWorkDir: string;
let priorEnv: string | undefined;

beforeEach(() => {
  configuredWorkDir = mkdtempSync(join(tmpdir(), "nb-configured-"));
  defaultishWorkDir = mkdtempSync(join(tmpdir(), "nb-default-"));
  priorEnv = process.env.NB_WORK_DIR;
  // The divergence under test: `defaultWorkDir()` resolves here, the runtime's
  // configured workDir is elsewhere.
  process.env.NB_WORK_DIR = defaultishWorkDir;
});

afterEach(() => {
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

/** Write a tokens.json under `root`, marking the connector as authenticated there. */
function writeTokens(root: string): void {
  const dir = workspaceOAuthDir(root, WS, SERVER);
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
function seededState(mgr: BundleLifecycleManager): string | undefined {
  let seen: string | undefined;
  (mgr as unknown as { recordConnectionStateChange: unknown }).recordConnectionStateChange = (
    _server: string,
    _ws: string,
    _principal: string,
    state: string,
  ): void => {
    seen = state;
  };
  (mgr as unknown as { seedUrlConnectionState: (s: string, w: string, r: BundleRef) => void })
    .seedUrlConnectionState(SERVER, WS, urlBundle());
  return seen;
}

test("seeds from the configured workDir, not NB_WORK_DIR", () => {
  const mgr = new BundleLifecycleManager(new NoopEventSink(), undefined);
  mgr.setWorkDir(configuredWorkDir);

  // Connected: the tokens exist under the workDir the runtime resolved.
  writeTokens(configuredWorkDir);

  expect(seededState(mgr)).toBe("running");
});

test("still seeds not_authenticated when no tokens exist anywhere", () => {
  const mgr = new BundleLifecycleManager(new NoopEventSink(), undefined);
  mgr.setWorkDir(configuredWorkDir);

  expect(seededState(mgr)).toBe("not_authenticated");
});

test("tokens under NB_WORK_DIR alone do not count as connected", () => {
  // The inverse of the first case, and the one that pins the direction: a
  // probe reading `defaultWorkDir()` would call this connected. It is not —
  // nothing the runtime writes lives there under this config.
  const mgr = new BundleLifecycleManager(new NoopEventSink(), undefined);
  mgr.setWorkDir(configuredWorkDir);

  writeTokens(defaultishWorkDir);

  expect(seededState(mgr)).toBe("not_authenticated");
});
