/**
 * Integration test for `nb__manage_app configure` — the interactive TUI path
 * where a user is prompted for a bundle's user_config values, the resolver
 * persists them to the workspace credential store, and the bundle is restarted.
 *
 * This test catches a specific regression class: if `configureBundle` ever
 * stops threading `wsId` / `workDir` into `startBundleSource`, the restart
 * throws after the bundle has already been removed from the registry — a
 * permanent session-scoped break. We exercise the full flow end-to-end with a
 * real subprocess MCP server so the restart path is actually executed.
 *
 * Companion to `test/integration/startup-credentials.test.ts` (which covers
 * the same resolver wiring at boot time via `startBundleSource` directly).
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { BundleLifecycleManager } from "../../src/bundles/lifecycle.ts";
import { getWorkspaceCredentials } from "../../src/config/workspace-credentials.ts";
import type { ConfirmationGate } from "../../src/config/privilege.ts";
import { extractText } from "../../src/engine/content-helpers.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createSystemTools } from "../../src/tools/system-tools.ts";
import type { ManageBundleContext } from "../../src/tools/types.ts";
import { WorkspaceStore } from "../../src/workspace/workspace-store.ts";

const BUNDLE_NAME = "@nbtest/configure-bundle";
// Mpak cache directory convention: `@scope/name` → `scope-name`.
const BUNDLE_CACHE_SLUG = "nbtest-configure-bundle";
// ToolRegistry source key: `deriveServerName` takes the post-slash segment.
const SERVER_NAME = "configure-bundle";
const WS_ID = "ws_configure";

const rootDir = join(tmpdir(), `nb-configure-integ-${Date.now()}-${process.pid}`);

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

interface Layout {
  mpakHome: string;
  workDir: string;
}

/**
 * Seed an mpak cache with a minimal but real MCP server that reads
 * `NBTEST_API_KEY` from its process env. The manifest's `user_config`
 * declares `api_key` as required and the `mcp_config.env` substitutes
 * it in — identical shape to real registry bundles.
 */
async function seedFixture(root: string): Promise<Layout> {
  const mpakHome = join(root, "mpak-home");
  const workDir = join(root, "nb-home");
  const cacheDir = join(mpakHome, "cache", BUNDLE_CACHE_SLUG);
  mkdirSync(cacheDir, { recursive: true });

  const nodeModulesPath = join(import.meta.dir, "../..", "node_modules");
  const serverCode = `
const { Server } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/index.js");
const { StdioServerTransport } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/server/stdio.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("${nodeModulesPath}/@modelcontextprotocol/sdk/dist/cjs/types.js");

async function main() {
  const server = new Server(
    { name: "configure-bundle", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "whoami", description: "echo the API key", inputSchema: { type: "object", properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: String(process.env.NBTEST_API_KEY ?? "<unset>") }],
  }));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
`;
  writeFileSync(join(cacheDir, "server.cjs"), serverCode);

  const manifest = {
    manifest_version: "0.3",
    name: BUNDLE_NAME,
    version: "0.1.0",
    description: "Test bundle for the configure tool",
    user_config: {
      api_key: { type: "string", title: "API key", sensitive: true, required: true },
    },
    server: {
      type: "node",
      entry_point: "server.cjs",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server.cjs"],
        env: { NBTEST_API_KEY: "${user_config.api_key}" },
      },
    },
  };
  writeFileSync(join(cacheDir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(
    join(cacheDir, ".mpak-meta.json"),
    JSON.stringify({
      version: "0.1.0",
      pulledAt: new Date().toISOString(),
      platform: { os: process.platform, arch: process.arch },
    }),
  );

  // Create the workspace directory so WorkspaceStore.get resolves.
  const store = new WorkspaceStore(workDir);
  await store.create("configure", WS_ID.replace(/^ws_/, ""));

  return { mpakHome, workDir };
}

describe("manage_app configure — end-to-end", () => {
  let layout: Layout;
  let prevMpakHome: string | undefined;

  beforeEach(async () => {
    const dir = join(rootDir, `case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    layout = await seedFixture(dir);
    prevMpakHome = process.env.MPAK_HOME;
    process.env.MPAK_HOME = layout.mpakHome;
  });

  function restoreEnv(): void {
    if (prevMpakHome === undefined) delete process.env.MPAK_HOME;
    else process.env.MPAK_HOME = prevMpakHome;
  }

  function buildTools(gate: ConfirmationGate) {
    const registry = new ToolRegistry();
    const sink = new NoopEventSink();
    const lifecycle = new BundleLifecycleManager(sink, undefined, false, layout.mpakHome);
    const store = new WorkspaceStore(layout.workDir);
    const ctx: ManageBundleContext = {
      getWorkspaceId: () => WS_ID,
      workspaceStore: store,
      workDir: layout.workDir,
      configDir: undefined,
      eventSink: sink,
    };
    const tools = createSystemTools(
      () => registry,
      undefined,
      gate,
      lifecycle,
      undefined,
      undefined,
      undefined,
      undefined,
      sink,
      undefined,
      undefined,
      layout.mpakHome,
      undefined,
      undefined,
      undefined,
      undefined,
      ctx,
    );
    return { tools, registry };
  }

  test(
    "prompts, persists, restarts — bundle is registered after configure",
    async () => {
      try {
        const gate: ConfirmationGate = {
          supportsInteraction: true,
          confirm: async () => true,
          promptConfigValue: async () => "sk-configured-abc",
        };
        const { tools, registry } = buildTools(gate);

        const result = await tools.execute("manage_app", {
          action: "configure",
          name: BUNDLE_NAME,
        });

        // Restart succeeded — this is the regression we're guarding against.
        // Previously `configureBundle` omitted wsId/workDir on the restart
        // call and `startBundleSource` threw after the bundle was already
        // deregistered, leaving a user-visible error and an empty registry.
        expect(result.isError).toBe(false);
        expect(extractText(result.content)).toMatch(/Configured and restarted/);

        // Bundle is back in the registry after restart.
        expect(registry.hasSource(SERVER_NAME)).toBe(true);

        // Credential landed in the workspace credential store, not ~/.mpak/.
        const creds = await getWorkspaceCredentials(WS_ID, BUNDLE_NAME, layout.workDir);
        expect(creds).toEqual({ api_key: "sk-configured-abc" });
      } finally {
        restoreEnv();
      }
    },
    10_000,
  );
});
