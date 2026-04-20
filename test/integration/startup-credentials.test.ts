/**
 * Integration tests for the credential-resolution wiring in the bundle
 * startup path. `startBundleSource` reads the workspace credential store
 * and hands whatever it finds to `mpak.prepareServer({ userConfig })`;
 * the SDK then tries the bundle's declared `mcp_config.env` aliases
 * and manifest defaults before throwing `MpakConfigError`. The host
 * translates that to a `nb config set -w <wsId>` hint.
 *
 * These tests seed the mpak bundle cache on disk with a hand-authored
 * manifest and exercise three paths:
 *
 *   - Store path:  credentials in the workspace credential store → bundle starts.
 *   - Env path:    credentials in the env var declared by the bundle's
 *                  own mcp_config.env mapping → bundle starts.
 *   - Failure:     no credentials anywhere → throws a friendly
 *                  MpakConfigError with the nb config set hint.
 *
 * The bundle itself is a minimal CommonJS MCP server that exposes a single
 * tool and echoes the credential env var the manifest declares.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { startBundleSource } from "../../src/bundles/startup.ts";
import { saveWorkspaceCredential } from "../../src/config/workspace-credentials.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const BUNDLE_NAME = "@nbtest/creds-bundle";
const BUNDLE_SLUG = "nbtest-creds-bundle";
const WS_ID = "ws_startup";
// This is the env var consumed by the bundle subprocess — it's what the
// manifest's `${user_config.api_key}` substitutes to.
const BUNDLE_ENV_VAR = "NBTEST_API_KEY";

const rootDir = join(tmpdir(), `nb-startup-creds-${Date.now()}-${process.pid}`);

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

interface SeededBundleLayout {
  mpakHome: string;
  workDir: string;
  cacheDir: string;
}

/**
 * Create a mpak cache entry for a named bundle with a `user_config.api_key`
 * field. The cache layout mirrors what mpak-sdk writes during a real install:
 * `{mpakHome}/cache/{slug}/{manifest.json, .mpak-meta.json, server.cjs}`.
 *
 * The server.cjs script is a standard-compliant MCP server that:
 *  - Reads `NBTEST_API_KEY` from its process env on startup.
 *  - Exposes a single `get_key` tool that returns the env value verbatim so
 *    tests can confirm the credential was substituted and delivered.
 *
 * Returns { mpakHome, workDir, cacheDir }.
 */
function seedBundleCache(root: string): SeededBundleLayout {
  const mpakHome = join(root, "mpak-home");
  const workDir = join(root, "nb-home");
  const cacheDir = join(mpakHome, "cache", BUNDLE_SLUG);
  mkdirSync(cacheDir, { recursive: true });

  // Keep the server script path resolution consistent with the real SDK:
  // `mcp_config.args` uses `${__dirname}` which the SDK substitutes to the
  // cache dir.
  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
  const serverCode = `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: "creds-bundle", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_key",
        description: "Return the value of NBTEST_API_KEY from the process env",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [
      { type: "text", text: String(process.env.NBTEST_API_KEY ?? "<unset>") },
    ],
  }));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
`;
  writeFileSync(join(cacheDir, "server.cjs"), serverCode);

  // Minimal valid MCPB manifest. The mpak SDK's McpbManifestSchema is fairly
  // strict, so we include the required fields and declare a `user_config`
  // entry that references NBTEST_API_KEY via the `${user_config.*}` placeholder.
  const manifest = {
    manifest_version: "0.3",
    name: BUNDLE_NAME,
    version: "0.1.0",
    description: "Test bundle for credential resolution wiring",
    user_config: {
      api_key: {
        type: "string",
        title: "API key",
        sensitive: true,
        required: true,
      },
    },
    server: {
      type: "node",
      entry_point: "server.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server.cjs"],
        env: {
          NBTEST_API_KEY: "${user_config.api_key}",
        },
      },
    },
  };
  writeFileSync(join(cacheDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // `.mpak-meta.json` lets `bundleCache.loadBundle` skip the network path.
  const meta = {
    version: "0.1.0",
    pulledAt: new Date().toISOString(),
    platform: { os: process.platform, arch: process.arch },
  };
  writeFileSync(join(cacheDir, ".mpak-meta.json"), JSON.stringify(meta));

  return { mpakHome, workDir, cacheDir };
}

describe("startBundleSource — credential resolution", () => {
  let layout: SeededBundleLayout;
  let prevMpakHome: string | undefined;
  let prevEnvVal: string | undefined;

  beforeEach(() => {
    const dir = join(rootDir, `case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    layout = seedBundleCache(dir);

    // Steer the mpak SDK to our seeded cache. `getMpak` caches the instance
    // by `mpakHome`, so swapping the env var (and using a unique path per
    // test) forces a fresh Mpak instance on the next call.
    prevMpakHome = process.env.MPAK_HOME;
    process.env.MPAK_HOME = layout.mpakHome;

    // Clear any leaked copy of the bundle-declared env var from a prior
    // test — the SDK's reverse-lookup tier reads this at resolve time.
    prevEnvVal = process.env[BUNDLE_ENV_VAR];
    delete process.env[BUNDLE_ENV_VAR];
  });

  // Restore env after each test so one case can't contaminate the next.
  function restoreEnv(): void {
    if (prevMpakHome === undefined) delete process.env.MPAK_HOME;
    else process.env.MPAK_HOME = prevMpakHome;
    if (prevEnvVal === undefined) delete process.env[BUNDLE_ENV_VAR];
    else process.env[BUNDLE_ENV_VAR] = prevEnvVal;
  }

  test(
    "happy path — workspace credential store satisfies user_config, bundle starts",
    async () => {
      try {
        await saveWorkspaceCredential(WS_ID, BUNDLE_NAME, "api_key", "sk-ws-123", layout.workDir);

        const registry = new ToolRegistry();
        const result = await startBundleSource(
          { name: BUNDLE_NAME },
          registry,
          new NoopEventSink(),
          undefined,
          { wsId: WS_ID, workDir: layout.workDir },
        );

        expect(result.sourceName).toBe("creds-bundle");
        expect(result.manifest?.name).toBe(BUNDLE_NAME);

        // Verify the credential actually propagated to the spawned process by
        // invoking the tool — its only job is to echo NBTEST_API_KEY.
        const tools = await registry.availableTools();
        expect(tools.some((t) => t.name === "creds-bundle__get_key")).toBe(true);

        const callResult = await registry.execute({
          id: "startup-credentials-happy",
          name: "creds-bundle__get_key",
          input: {},
        });
        expect(callResult.isError).toBe(false);
        const firstText = callResult.content.find((c) => c.type === "text");
        expect(firstText && "text" in firstText ? firstText.text : "").toBe("sk-ws-123");

        await registry.removeSource(result.sourceName);
      } finally {
        restoreEnv();
      }
    },
    20_000,
  );

  test(
    "env path — bundle-declared env var (mcp_config.env) satisfies user_config",
    async () => {
      try {
        // The bundle's manifest declares
        //   `"NBTEST_API_KEY": "${user_config.api_key}"`
        // which the SDK reads in reverse: if the host has NBTEST_API_KEY
        // set, the api_key field is satisfied. No NB_CONFIG_* prefix, no
        // host convention — just the bundle's own mapping.
        process.env[BUNDLE_ENV_VAR] = "sk-env-456";

        const registry = new ToolRegistry();
        const result = await startBundleSource(
          { name: BUNDLE_NAME },
          registry,
          new NoopEventSink(),
          undefined,
          { wsId: WS_ID, workDir: layout.workDir },
        );
        expect(result.sourceName).toBe("creds-bundle");

        const callResult = await registry.execute({
          id: "startup-credentials-env",
          name: "creds-bundle__get_key",
          input: {},
        });
        const firstText = callResult.content.find((c) => c.type === "text");
        expect(firstText && "text" in firstText ? firstText.text : "").toBe("sk-env-456");

        await registry.removeSource(result.sourceName);
      } finally {
        restoreEnv();
      }
    },
    20_000,
  );

  test(
    "failure path — no credentials anywhere throws with actionable error",
    async () => {
      try {
        const registry = new ToolRegistry();
        const call = startBundleSource(
          { name: BUNDLE_NAME },
          registry,
          new NoopEventSink(),
          undefined,
          { wsId: WS_ID, workDir: layout.workDir },
        );

        // The resolver's error should mention both the field and the
        // remediation command — this is the replacement for the original
        // user bug where mpak's opaque MpakConfigError was surfaced instead.
        await expect(call).rejects.toThrow(/api_key|API key/i);
        await expect(call).rejects.toThrow(/nb config set/);
        await expect(call).rejects.toThrow(WS_ID);

        // The failed startup must not leave the source in the registry.
        expect(registry.hasSource("creds-bundle")).toBe(false);
      } finally {
        restoreEnv();
      }
    },
    20_000,
  );

  test(
    "precondition — omitting wsId throws a clear error before hitting prepareServer",
    async () => {
      try {
        const registry = new ToolRegistry();
        const call = startBundleSource(
          { name: BUNDLE_NAME },
          registry,
          new NoopEventSink(),
          undefined,
          // Deliberately no wsId.
          { workDir: layout.workDir },
        );

        await expect(call).rejects.toThrow(/workspace ID is required/i);
      } finally {
        restoreEnv();
      }
    },
    10_000,
  );
});
