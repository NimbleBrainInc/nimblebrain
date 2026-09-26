/**
 * MCP Apps tool visibility (`_meta.ui.visibility`) as read from a connector.
 *
 * The connector here is a plain SDK `Server`, not a platform in-process app, so
 * the visibility it declares is the server's own and crosses the MCP wire
 * (`InMemoryTransport`) exactly as a third party's would.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { NoopEventSink } from "../../../src/adapters/noop-events.ts";
import { isAppCallable, isModelVisible, toolVisibility } from "../../../src/engine/types.ts";
import { McpSource } from "../../../src/tools/mcp-source.ts";
import { ToolRegistry } from "../../../src/tools/registry.ts";
import { surfaceTools } from "../../../src/tools/surfacing.ts";

describe("toolVisibility", () => {
  test("absent means both, the spec's default", () => {
    expect(toolVisibility({})).toEqual(["model", "app"]);
    expect(toolVisibility({ meta: { ui: { resourceUri: "ui://x/y" } } })).toEqual(["model", "app"]);
  });

  test("an array is read as declared", () => {
    const appOnly = { meta: { ui: { visibility: ["app"] } } };
    expect(isModelVisible(appOnly)).toBe(false);
    expect(isAppCallable(appOnly)).toBe(true);
    const modelOnly = { meta: { ui: { visibility: ["model"] } } };
    expect(isModelVisible(modelOnly)).toBe(true);
    expect(isAppCallable(modelOnly)).toBe(false);
  });

  test("a value that is not an array is read as absent", () => {
    expect(toolVisibility({ meta: { ui: { visibility: "app" } } })).toEqual(["model", "app"]);
  });
});

async function connectorSource(): Promise<McpSource> {
  const server = new Server({ name: "dash", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "refresh",
        description: "Refresh the dashboard",
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["app"] } },
      },
      {
        name: "report",
        description: "Report on the dashboard",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `ran ${request.params.name}` }],
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const source = new McpSource(
    "dash",
    { type: "inProcess", createServer: async () => ({ server, clientTransport }) },
    new NoopEventSink(),
  );
  await source.start();
  return source;
}

describe("a connector's app-only tool", () => {
  let source: McpSource | undefined;
  afterEach(async () => {
    if (source) await source.stop();
    source = undefined;
  });

  test("is hidden from the model's tool list but callable by name", async () => {
    source = await connectorSource();
    const registry = new ToolRegistry();
    registry.addSource(source);

    const all = await registry.availableTools();
    const { direct, proxied } = surfaceTools(all, null);
    const surfaced = [...direct, ...proxied].map((t) => t.name);
    expect(surfaced).not.toContain("dash__refresh");
    expect(surfaced).toContain("dash__report");

    const result = await registry.execute({ id: "c1", name: "dash__refresh", input: {} });
    expect(result.isError).toBe(false);
    expect((result.content[0] as { text?: string }).text).toBe("ran refresh");
  });
});
