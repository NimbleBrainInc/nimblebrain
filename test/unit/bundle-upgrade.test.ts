import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import type { EngineEvent } from "../../src/engine/types.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

// Unit coverage for the bundle-upgrade revival's lifecycle pieces: the
// `installSource` derivation that `check_updates`/`upgrade` filter on, and the
// `upgrade()` guard/no-op paths. The force-refresh re-spawn and the manage_
// connectors handlers are exercised in integration (they need a Runtime/store).

const noopSink = new NoopEventSink();
const wsId = "ws_upgrade_test";

let mpakHome: string;
let prevWorkDir: string | undefined;
let tmpWorkDir: string;

beforeEach(() => {
  mpakHome = mkdtempSync(join(tmpdir(), "nb-upgrade-mpak-"));
  // Seeding a URL bundle records connection state under the work dir — point
  // it at a temp dir so the test never writes to ~/.nimblebrain.
  tmpWorkDir = mkdtempSync(join(tmpdir(), "nb-upgrade-work-"));
  prevWorkDir = process.env.NB_WORK_DIR;
  process.env.NB_WORK_DIR = tmpWorkDir;
});

afterEach(() => {
  if (prevWorkDir === undefined) delete process.env.NB_WORK_DIR;
  else process.env.NB_WORK_DIR = prevWorkDir;
  rmSync(mpakHome, { recursive: true, force: true });
  rmSync(tmpWorkDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// installSource derivation in seedInstance — the single chokepoint for both
// connector-install and boot reload.
// ---------------------------------------------------------------------------

describe("seedInstance installSource derivation", () => {
  it("derives registry for a named (mpak) ref", () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    lifecycle.seedInstance("echo", "@nimblebraininc/echo", { name: "@nimblebraininc/echo" }, undefined, wsId);
    expect(lifecycle.getInstance("echo", wsId)?.installSource).toBe("registry");
  });

  it("derives local for a path ref", () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    lifecycle.seedInstance("local-dev", "/home/dev/bundles/test", { path: "/home/dev/bundles/test" }, undefined, wsId);
    expect(lifecycle.getInstance("local-dev", wsId)?.installSource).toBe("local");
  });

  it("derives remote for a url ref", () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    lifecycle.seedInstance(
      "remote-svc",
      "https://api.example.com/mcp",
      { url: "https://api.example.com/mcp" },
      undefined,
      wsId,
    );
    expect(lifecycle.getInstance("remote-svc", wsId)?.installSource).toBe("remote");
  });
});

// ---------------------------------------------------------------------------
// upgrade() guards + no-op. The happy-path re-spawn needs a real mpak pull and
// is covered in integration; here we pin the cheap, network-free branches.
// ---------------------------------------------------------------------------

describe("BundleLifecycleManager.upgradeApp", () => {
  const getRegistry = () => new ToolRegistry();

  it("throws when the app isn't installed in any workspace", async () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    await expect(lifecycle.upgradeApp("@nope/none", getRegistry)).rejects.toThrow(
      /not installed in any workspace/,
    );
  });

  it("ignores non-registry installs (local-only app has no registry target)", async () => {
    const lifecycle = new BundleLifecycleManager(noopSink, undefined, false, mpakHome);
    // bundleName for a path install is the path; it's installSource=local, so
    // upgradeApp finds no registry target and treats it as not installed.
    lifecycle.seedInstance("local-dev", "/dev/foo", { path: "/dev/foo" }, undefined, wsId);
    await expect(lifecycle.upgradeApp("/dev/foo", getRegistry)).rejects.toThrow(
      /not installed in any workspace/,
    );
  });

  it("is a no-op (from === to, no event) when no newer version is published", async () => {
    const events: EngineEvent[] = [];
    const sink = { emit: (e: EngineEvent) => events.push(e) };
    const lifecycle = new BundleLifecycleManager(sink, undefined, false, mpakHome);
    // Registry instances in two workspaces, but nothing is cached and no
    // registry is reachable → checkForUpdate returns null → upgradeApp returns
    // early without force-pulling or re-spawning anything.
    for (const ws of ["ws_a", "ws_b"]) {
      lifecycle.seedInstance(
        "upgradeable",
        "@testscope/upgradeable",
        { name: "@testscope/upgradeable" },
        { version: "0.1.0", ui: null, briefing: null, type: "plain", httpProxy: null },
        ws,
      );
    }
    const result = await lifecycle.upgradeApp("@testscope/upgradeable", getRegistry);
    expect(result.from).toBe("0.1.0");
    expect(result.to).toBe("0.1.0");
    expect(result.workspaces).toEqual([]);
    expect(events.filter((e) => e.type === "bundle.upgraded")).toHaveLength(0);
  });
});
