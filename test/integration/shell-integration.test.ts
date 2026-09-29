import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ShellResponse, ToolCallResponse } from "../../src/api/schemas/responses.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import type { ConnectorRef, PlacementDeclaration } from "../../src/connectors/runtime/types.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { devProvider } from "../helpers/dev-provider.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { readJson } from "../helpers/http.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/** What `POST …/tools/call` answers: the tool result's wire fields. */

// ---------------------------------------------------------------------------
// Test setup: Runtime + HTTP server + temp directory for connectors
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `nimblebrain-shell-integ-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;

beforeAll(async () => {
  const workDir = join(testDir, "work");
  mkdirSync(workDir, { recursive: true });

  runtime = await Runtime.start({
    identityProvider: devProvider,
    model: { provider: "custom", adapter: createEchoModel() },
    workDir,
    logging: { disabled: true },
  });
  await provisionTestWorkspace(runtime);

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

// ---------------------------------------------------------------------------
// Helper: record a connector on the lifecycle, as the install path does
// ---------------------------------------------------------------------------

/**
 * Seed one connector into the workspace and register whatever chrome it
 * declares. Placements ride on the `ConnectorRef.ui` the install path copies from
 * the operator-trusted catalog entry, so the shell surface needs no live
 * source to render them.
 */
async function installConnector(name: string, placements: PlacementDeclaration[]): Promise<string> {
  const ref: ConnectorRef = {
    url: `https://${name}.example.com/mcp`,
    serverName: name,
    ui: { name: `${name} App`, icon: `${name}-icon`, placements },
  };
  const lifecycle = runtime.getLifecycle();
  await lifecycle.seedInstance(name, ref.url, ref, undefined, TEST_WORKSPACE_ID);
  lifecycle.notifyInstalled(name, TEST_WORKSPACE_ID);
  return name;
}

// ---------------------------------------------------------------------------
// Helper: create MCP client
// ---------------------------------------------------------------------------

async function createMcpClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`),
  );
  const client = new Client({ name: "integ-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

// =============================================================================
// 1. Install connector → /v1/workspaces/:wsId/shell shows placements → uninstall → gone
// =============================================================================

describe("Install/uninstall → /v1/workspaces/:wsId/shell placement updates", () => {
  it("install connector with placements → GET /v1/workspaces/:wsId/shell includes them → uninstall → gone", async () => {
    const devRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
    const serverName = await installConnector("tasks", [
      { slot: "sidebar.apps", resourceUri: "ui://tasks/nav", priority: 30, label: "Tasks" },
      { slot: "main", resourceUri: "ui://tasks/board", route: "tasks", label: "Task Board" },
    ]);

    try {
      // GET /v1/workspaces/:wsId/shell should now include the tasks placements
      const shellRes = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/shell`);
      expect(shellRes.status).toBe(200);
      const shell = await readJson<ShellResponse>(shellRes);

      const tasksPlacements = shell.placements.filter(
        (p: { serverName: string }) => p.serverName === serverName,
      );
      expect(tasksPlacements.length).toBe(2);

      const slots = tasksPlacements.map((p: { slot: string }) => p.slot);
      expect(slots).toContain("sidebar.apps");
      expect(slots).toContain("main");

      // Uninstall
      await runtime.getLifecycle().uninstall(serverName, devRegistry, TEST_WORKSPACE_ID);

      // GET /v1/workspaces/:wsId/shell should no longer have tasks placements
      const shellRes2 = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/shell`);
      const shell2 = await readJson<ShellResponse>(shellRes2);

      const tasksAfter = shell2.placements.filter(
        (p: { serverName: string }) => p.serverName === serverName,
      );
      expect(tasksAfter.length).toBe(0);
    } catch (err) {
      // Clean up on failure
      try {
        await runtime.getLifecycle().uninstall(serverName, devRegistry, TEST_WORKSPACE_ID);
      } catch {}
      throw err;
    }
  }, 15_000);
});

// =============================================================================
// 2. Connector with placements → appears in /v1/workspaces/:wsId/shell
// =============================================================================

describe("Connector with placements → /v1/workspaces/:wsId/shell", () => {
  it("connector with main placement appears in /v1/workspaces/:wsId/shell", async () => {
    const devRegistry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);
    const serverName = await installConnector("placedapp", [
      {
        slot: "main",
        resourceUri: "ui://placedapp/main",
        label: "placedapp App",
        icon: "placedapp-icon",
        route: "placedapp",
      },
    ]);

    try {
      const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/shell`);
      const body = await readJson<ShellResponse>(res);

      const entries = body.placements.filter(
        (p: { serverName: string }) => p.serverName === serverName,
      );
      expect(entries.length).toBe(1);
      expect(entries[0].slot).toBe("main");
      expect(entries[0].resourceUri).toBe("ui://placedapp/main");
      expect(entries[0].label).toBe("placedapp App");

      await runtime.getLifecycle().uninstall(serverName, devRegistry, TEST_WORKSPACE_ID);
    } catch (err) {
      try {
        await runtime.getLifecycle().uninstall(serverName, devRegistry, TEST_WORKSPACE_ID);
      } catch {}
      throw err;
    }
  }, 15_000);
});

// =============================================================================
// 3. MCP client → /mcp → lists nb__ tools → calls nb__workspace_info
// =============================================================================

describe("MCP client e2e with nb tools", () => {
  // Stage 2: every tool name is namespaced as `ws_<id>/<source>__<tool>`.
  const NB_PREFIX = "nb__";

  it("listTools includes nb__ prefixed tools", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.listTools();
      const coreTools = result.tools.filter((t) => t.name.startsWith(NB_PREFIX));
      expect(coreTools.length).toBeGreaterThanOrEqual(7);

      // A genuinely agent-facing nb__ tool — not an app-only (`ui.visibility: ["app"]`)
      // one (e.g. workspace_info), which the /mcp listing strips.
      const names = coreTools.map((t) => t.name).sort();
      expect(names).toContain(`${NB_PREFIX}search`);
      // Regression pin: app-only tools are absent from the /mcp listing
      // (workspace_info is one). Fails if the filter
      // in mcp-server.ts tools/list is dropped, even though the tool stays
      // callable by name (see the callTool tests below).
      expect(names).not.toContain(`${NB_PREFIX}workspace_info`);
    } finally {
      await client.close();
    }
  });

  it("listTools includes nb__ system tools", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.listTools();
      const nbTools = result.tools.filter((t) => t.name.startsWith(NB_PREFIX));
      expect(nbTools.length).toBeGreaterThanOrEqual(1);

      const names = nbTools.map((t) => t.name);
      expect(names).toContain(`${NB_PREFIX}search`);
    } finally {
      await client.close();
    }
  });

  it("callTool nb__workspace_info returns structured data", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({
        name: `${NB_PREFIX}workspace_info`,
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(Array.isArray(result.content)).toBe(true);
      const textBlocks = result.content as Array<{ type: string; text: string }>;
      expect(textBlocks[0]!.type).toBe("text");
      // MCP protocol returns content blocks, not structuredContent.
      // The text should contain a human-readable workspace summary.
      expect(textBlocks[0]!.text.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});

// =============================================================================
// 4. Core tools via Bridge proxy (POST /v1/workspaces/:wsId/tools/call server=nb)
// =============================================================================

describe("POST /v1/workspaces/:wsId/tools/call — all core tools via Bridge proxy", () => {
  it("workspace_info returns content", async () => {
    const res = await fetch(`${baseUrl}/v1/workspaces/${TEST_WORKSPACE_ID}/tools/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server: "nb", tool: "workspace_info", arguments: {} }),
    });
    expect(res.status).toBe(200);
    const body = await readJson<ToolCallResponse>(res);
    expect(body.isError).toBe(false);
    expect(Array.isArray(body.content)).toBe(true);
  });
});
