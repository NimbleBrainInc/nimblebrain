/**
 * An app's server announces its own change, and the app's views hear it.
 *
 * The motivating case: an app with a sidebar list and an inline view. The
 * inline view saves through `/mcp` — the door every app iframe uses — and the
 * sidebar must re-read. The host does not guess that from the call; the app's
 * server says so, by sending `notifications/resources/list_changed` while it
 * handles the write. This drives that path end to end: a real MCP server behind
 * a real `McpSource` in a workspace registry, a real `/mcp` client, and the
 * `data.changed` broadcast the web shell forwards to the app's iframes.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-server-announced-${Date.now()}`);

/**
 * A notes app whose server announces changes the way the MCP spec says to:
 * `save` writes and sends `resources/list_changed` from inside the call;
 * `list` only reads, and sends nothing.
 */
function notesSource(sink: ReturnType<Runtime["getEventSink"]>): McpSource {
  const notes: string[] = [];
  return new McpSource(
    "notes",
    {
      type: "inProcess",
      createServer: async () => {
        const server = new Server(
          { name: "notes", version: "1.0.0" },
          { capabilities: { tools: {}, resources: { listChanged: true } } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            { name: "save", inputSchema: { type: "object", properties: {} } },
            { name: "list", inputSchema: { type: "object", properties: {} } },
          ],
        }));
        server.setRequestHandler(ListResourcesRequestSchema, async () => ({
          resources: notes.map((_, i) => ({ uri: `notes://${i}`, name: `note ${i}` })),
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          if (request.params.name === "save") {
            notes.push("note");
            await server.sendResourceListChanged();
          }
          return { content: [{ type: "text", text: `${notes.length} notes` }] };
        });
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        return { server, clientTransport };
      },
    },
    sink,
  );
}

async function createMcpClient(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { "x-workspace-id": TEST_WORKSPACE_ID } },
  });
  const client = new Client({ name: "app-iframe", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** The notification crosses the in-memory pair after the call resolves. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeAll(async () => {
  mkdirSync(testDir, { recursive: true });
  runtime = await Runtime.start({
    model: { provider: "custom", adapter: createEchoModel() },
    logging: { disabled: true },
    workDir: testDir,
  });
  await provisionTestWorkspace(runtime);

  const source = notesSource(runtime.getEventSink());
  await source.start();
  runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("server-announced data.changed", () => {
  const broadcasts: Record<string, unknown>[] = [];
  beforeAll(() => {
    handle.sseManager.onEvent((event, data) => {
      if (event === "data.changed") broadcasts.push(data);
    });
  });
  beforeEach(() => {
    broadcasts.length = 0;
  });

  it("a write whose server announces the change broadcasts to that app, in its workspace", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({ name: "notes__save", arguments: {} });
      expect(result.isError).toBeFalsy();
      await settle();

      expect(broadcasts).toEqual([
        {
          source: "server",
          server: "notes",
          wsId: TEST_WORKSPACE_ID,
          timestamp: expect.any(String),
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it("a read announces nothing, so nothing broadcasts", async () => {
    // The /mcp door itself never broadcasts: only the server's announcement
    // does, and a read does not make one. That is what keeps a view that
    // re-reads on every event from looping.
    const client = await createMcpClient();
    try {
      await client.callTool({ name: "notes__list", arguments: {} });
      await settle();

      expect(broadcasts).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
