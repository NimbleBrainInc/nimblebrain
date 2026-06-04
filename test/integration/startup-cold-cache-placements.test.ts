/**
 * Regression test for #60 — "Bundle placements silently fail to register on
 * cold cache."
 *
 * A named bundle declares UI placements under
 * `_meta["ai.nimblebrain/host"].placements`. `startBundleSource` reads the
 * manifest from the mpak bundle cache up front to derive that metadata. On a
 * cold (first-ever) install the cache is empty, so the read returned null and
 * `meta` stayed null — the bundle spawned (tools worked, it showed under
 * Connectors) but its `sidebar.apps` placement never registered, so it never
 * appeared under Apps until a process restart re-read the now-warm cache.
 *
 * The fix warms the cache at the start of the named-bundle branch, guarded on
 * `getBundleManifest` so a manifest-already-present cache (warm boot, offline
 * start) adds no network call.
 *
 * These tests reproduce a cold→warm transition deterministically by stubbing
 * `bundleCache.loadBundle` to MATERIALIZE the cache on disk (what a real
 * registry download does) instead of hitting the network.
 */

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { getMpak } from "../../src/bundles/mpak.ts";
import { startBundleSource } from "../../src/bundles/startup.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const BUNDLE_NAME = "@nbtest/cold-cache-app";
const BUNDLE_SLUG = "nbtest-cold-cache-app";
const SOURCE_NAME = "cold-cache-app";
const WS_ID = "ws_cold_cache";

const rootDir = join(tmpdir(), `nb-cold-cache-${Date.now()}-${process.pid}`);

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

/**
 * Write the bundle artifacts a real mpak download would produce into the
 * cache dir: a minimal MCP server, a manifest declaring a `sidebar.apps`
 * placement, and the `.mpak-meta.json` marker. Idempotent.
 */
function materializeCache(cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true });

  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
  const serverCode = `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const { ListToolsRequestSchema } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: "cold-cache-app", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "noop", description: "no-op", inputSchema: { type: "object", properties: {} } },
    ],
  }));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
`;
  writeFileSync(join(cacheDir, "server.cjs"), serverCode);

  const manifest = {
    manifest_version: "0.4",
    name: BUNDLE_NAME,
    version: "0.1.0",
    description: "Cold-cache placement regression bundle",
    author: { name: "Test Author" },
    server: {
      type: "node",
      entry_point: "server.cjs",
      mcp_config: { command: "node", args: ["${__dirname}/server.cjs"] },
    },
    _meta: {
      "ai.nimblebrain/host": {
        host_version: "1.0",
        name: "Cold Cache App",
        icon: "file-text",
        placements: [
          {
            slot: "sidebar.apps",
            resourceUri: "ui://cold-cache/main",
            route: BUNDLE_NAME,
            label: "Cold Cache",
            icon: "file-text",
          },
        ],
      },
    },
  };
  writeFileSync(join(cacheDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  writeFileSync(
    join(cacheDir, ".mpak-meta.json"),
    JSON.stringify({
      version: "0.1.0",
      pulledAt: new Date().toISOString(),
      platform: { os: process.platform, arch: process.arch },
    }),
  );
}

describe("startBundleSource — cold-cache placement registration (#60)", () => {
  let mpakHome: string;
  let workDir: string;
  let cacheDir: string;
  let prevMpakHome: string | undefined;

  beforeEach(() => {
    const dir = join(rootDir, `case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mpakHome = join(dir, "mpak-home");
    workDir = join(dir, "nb-home");
    cacheDir = join(mpakHome, "cache", BUNDLE_SLUG);

    // Point the mpak SDK at this case's home. getMpak caches by mpakHome, so a
    // unique path per test yields a fresh singleton we can spy on.
    prevMpakHome = process.env.MPAK_HOME;
    process.env.MPAK_HOME = mpakHome;
  });

  function restoreEnv(): void {
    if (prevMpakHome === undefined) delete process.env.MPAK_HOME;
    else process.env.MPAK_HOME = prevMpakHome;
  }

  test(
    "cold cache: placements register on first start without a restart",
    async () => {
      // Cold: nothing on disk yet. loadBundle stands in for the registry
      // download, materializing the cache the first time it's called.
      expect(existsSync(cacheDir)).toBe(false);

      const mpak = getMpak(mpakHome);
      const loadSpy = spyOn(mpak.bundleCache, "loadBundle").mockImplementation(async () => {
        materializeCache(cacheDir);
        return { cacheDir, version: "0.1.0", pulled: true };
      });

      const registry = new ToolRegistry();
      try {
        const result = await startBundleSource({ name: BUNDLE_NAME }, registry, new NoopEventSink(), undefined, {
          wsId: WS_ID,
          workDir,
        });

        // The warm step ran (cache was cold → loadBundle invoked)...
        expect(loadSpy).toHaveBeenCalled();
        // ...so the up-front manifest read was a hit and meta carries the
        // placement. Before the fix, meta was null here.
        expect(result.meta).not.toBeNull();
        const placements = result.meta?.ui?.placements ?? [];
        expect(placements).toHaveLength(1);
        expect(placements[0]?.slot).toBe("sidebar.apps");
        expect(result.manifest?.name).toBe(BUNDLE_NAME);

        await registry.removeSource(result.sourceName);
      } finally {
        loadSpy.mockRestore();
        restoreEnv();
      }
    },
    20_000,
  );

  test(
    "warm cache: the guard adds no extra cache pull (manifest already present)",
    async () => {
      // Warm: manifest already on disk before startBundleSource runs.
      materializeCache(cacheDir);

      const mpak = getMpak(mpakHome);
      const loadSpy = spyOn(mpak.bundleCache, "loadBundle").mockImplementation(async () => ({
        cacheDir,
        version: "0.1.0",
        pulled: false,
      }));

      const registry = new ToolRegistry();
      try {
        const result = await startBundleSource({ name: BUNDLE_NAME }, registry, new NoopEventSink(), undefined, {
          wsId: WS_ID,
          workDir,
        });

        // The guard keys on getBundleManifest (manifest present) and skips its
        // pre-warm, so the only loadBundle call is prepareServer's internal
        // one. An unguarded `await loadBundle` would make this 2 — and would
        // hit the network on a manifest-only cache.
        expect(loadSpy).toHaveBeenCalledTimes(1);
        expect(result.meta?.ui?.placements ?? []).toHaveLength(1);

        await registry.removeSource(result.sourceName);
      } finally {
        loadSpy.mockRestore();
        restoreEnv();
      }
    },
    20_000,
  );
});
