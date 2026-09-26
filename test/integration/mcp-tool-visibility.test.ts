/**
 * MCP Apps tool visibility (`_meta.ui.visibility`) on `/mcp`, for a connector
 * reached over a real HTTP wire.
 *
 * The spec binds a host twice: a tool without `"model"` is left out of an
 * agent's tool list, and an app's `tools/call` is refused for a tool without
 * `"app"`. A call is an app's when it names a source under
 * `RESOURCE_SOURCE_META_KEY`, which is how the iframe bridge sends every call
 * a view makes; it is then also held to that one server.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { RESOURCE_SOURCE_META_KEY } from "../../src/api/mcp-server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { surfaceTools } from "../../src/tools/surfacing.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { type RemoteMcpFixture, startRemoteMcpServer } from "../helpers/remote-mcp-fixture.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

/** A third-party server declaring each visibility the spec allows. */
function createVisibilityServer(): Server {
  const server = new Server({ name: "vis", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "refresh",
        description: "Refresh the dashboard (a view's button)",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "summarize",
        description: "Summarize the dashboard for the agent",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model"] } },
      },
      {
        name: "ping",
        description: "Returns pong",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `ran ${request.params.name}` }],
  }));
  return server;
}

/** A second server in the same workspace, outside the `vis` app's scope. */
function createNeighborServer(): Server {
  const server = new Server({ name: "neighbor", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", description: "Returns pong", inputSchema: { type: "object", properties: {} } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
  return server;
}

const testDir = join(tmpdir(), `nimblebrain-mcp-tool-visibility-${Date.now()}`);

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
let visServer: RemoteMcpFixture;
let neighborServer: RemoteMcpFixture;
let visSource: McpSource;
let neighborSource: McpSource;

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);
  const registry = runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID);

  visServer = startRemoteMcpServer(createVisibilityServer);
  visSource = new McpSource(
    "vis",
    { type: "remote", url: new URL(visServer.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await visSource.start();
  registry.addSource(visSource);

  neighborServer = startRemoteMcpServer(createNeighborServer);
  neighborSource = new McpSource(
    "neighbor",
    { type: "remote", url: new URL(neighborServer.url), allowInsecure: true },
    new NoopEventSink(),
  );
  await neighborSource.start();
  registry.addSource(neighborSource);

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
}, 30_000);

afterAll(async () => {
  handle?.stop(true);
  try {
    await visSource?.stop();
  } catch {
    // already stopped
  }
  try {
    await neighborSource?.stop();
  } catch {
    // already stopped
  }
  visServer?.close();
  neighborServer?.close();
  await runtime?.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
}, 30_000);

async function createMcpClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/${TEST_WORKSPACE_ID}`));
  const client = new Client({ name: "mcp-tool-visibility-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

function firstText(result: { content?: unknown }): string | undefined {
  return (result.content as Array<{ text?: string }> | undefined)?.[0]?.text;
}

describe("MCP Apps tool visibility — agent tool lists", () => {
  it("the /mcp tools/list leaves out a tool without \"model\"", async () => {
    const client = await createMcpClient();
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("vis__refresh");
      expect(names).toContain("vis__summarize");
      expect(names).toContain("vis__ping");
    } finally {
      await client.close();
    }
  });

  it("the chat surface leaves it out too", async () => {
    const all = await runtime.listToolsForWorkspace(TEST_WORKSPACE_ID);
    expect(all.map((t) => t.name)).toContain("vis__refresh");
    const { direct, proxied } = surfaceTools(all, null);
    const surfaced = [...direct, ...proxied].map((t) => t.name);
    expect(surfaced).not.toContain("vis__refresh");
    expect(surfaced).toContain("vis__summarize");
  });

  it("an app-only tool stays callable by name", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({ name: "vis__refresh", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toBe("ran refresh");
    } finally {
      await client.close();
    }
  });
});

describe("MCP Apps tool visibility — an app's tools/call", () => {
  it("reaches an app-only tool of its own server", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({
        name: "vis__refresh",
        arguments: {},
        _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
      });
      expect(result.isError).toBeFalsy();
      expect(firstText(result)).toBe("ran refresh");
    } finally {
      await client.close();
    }
  });

  it("reaches a tool with the default visibility", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({
        name: "vis__ping",
        arguments: {},
        _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it("is refused for a tool without \"app\"", async () => {
    const client = await createMcpClient();
    try {
      await expect(
        client.callTool({
          name: "vis__summarize",
          arguments: {},
          _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
        }),
      ).rejects.toThrow(/not callable from an app/);
    } finally {
      await client.close();
    }
  });

  it("is refused for another server's tool", async () => {
    const client = await createMcpClient();
    try {
      await expect(
        client.callTool({
          name: "neighbor__ping",
          arguments: {},
          _meta: { [RESOURCE_SOURCE_META_KEY]: "vis" },
        }),
      ).rejects.toThrow(/scoped to that server/);
    } finally {
      await client.close();
    }
  });

  it("an agent's call (no source named) reaches a model-only tool", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({ name: "vis__summarize", arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });
});
