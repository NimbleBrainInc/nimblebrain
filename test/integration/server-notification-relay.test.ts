/**
 * An app's server announces its own change, and the host relays it to the
 * app's views; the app's views list what changed from the app's own server.
 *
 * The motivating case: an app with a sidebar list and an inline view. The
 * inline view saves through `/mcp` — the door every app iframe uses — and the
 * sidebar must re-read. The host does not guess that from the call; the app's
 * server says so, by sending `notifications/resources/list_changed` while it
 * handles the write, and the host relays that notification as it was sent.
 * This drives the path end to end: a real MCP server behind a real `McpSource`
 * in a workspace registry, a real `/mcp` client, and the `server.notification`
 * SSE event the web shell posts verbatim to the app's iframes. The listings
 * the iframe then makes (`resources/list`, `resources/templates/list`) are
 * scoped to the one server the bridge names.
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
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_SOURCE_META_KEY } from "../../src/api/mcp-server.ts";
import type { ServerHandle } from "../../src/api/server.ts";
import { startServer } from "../../src/api/server.ts";
import { Runtime } from "../../src/runtime/runtime.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { createEchoModel } from "../helpers/echo-model.ts";
import { provisionTestWorkspace, TEST_WORKSPACE_ID } from "../helpers/test-workspace.ts";

let runtime: Runtime;
let handle: ServerHandle;
let baseUrl: string;
const testDir = join(tmpdir(), `nimblebrain-server-notification-relay-${Date.now()}`);

/**
 * A notes app whose server announces changes the way the MCP spec says to:
 * `save` writes and sends `resources/list_changed` from inside the call;
 * `list` only reads, and sends nothing. Its resource listing pages one note at
 * a time, so a cursor has to survive the host to reach the second page.
 */
function notesSource(name: string, sink: ReturnType<Runtime["getEventSink"]>): McpSource {
  const notes: string[] = [];
  return new McpSource(
    name,
    {
      type: "inProcess",
      createServer: async () => {
        const server = new Server(
          { name, version: "1.0.0" },
          { capabilities: { tools: {}, resources: { listChanged: true } } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            { name: "save", inputSchema: { type: "object", properties: {} } },
            { name: "list", inputSchema: { type: "object", properties: {} } },
          ],
        }));
        server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
          const page = Number(request.params?.cursor ?? 0);
          return {
            resources: notes
              .slice(page, page + 1)
              .map((_, i) => ({ uri: `${name}://${page + i}`, name: `note ${page + i}` })),
            ...(page + 1 < notes.length ? { nextCursor: String(page + 1) } : {}),
          };
        });
        server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
          resourceTemplates: [{ uriTemplate: `${name}://{index}`, name: "note" }],
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

  for (const name of ["notes", "other"]) {
    const source = notesSource(name, runtime.getEventSink());
    await source.start();
    runtime.getRegistryForWorkspace(TEST_WORKSPACE_ID).addSource(source);
  }

  handle = startServer({ runtime, port: 0 });
  baseUrl = `http://localhost:${handle.port}`;
});

afterAll(async () => {
  handle.stop(true);
  await runtime.shutdown();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

describe("the server-notification relay", () => {
  const relayed: Record<string, unknown>[] = [];
  beforeAll(() => {
    handle.sseManager.onEvent((event, data) => {
      if (event === "server.notification") relayed.push(data);
    });
  });
  beforeEach(() => {
    relayed.length = 0;
  });

  it("a write whose server announces the change is relayed to that app, in its workspace", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.callTool({ name: "notes__save", arguments: {} });
      expect(result.isError).toBeFalsy();
      await settle();

      expect(relayed).toEqual([
        {
          server: "notes",
          workspaceId: TEST_WORKSPACE_ID,
          method: "notifications/resources/list_changed",
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it("a read announces nothing, so nothing is relayed", async () => {
    // The /mcp door itself never relays: only the server's announcement does,
    // and a read does not make one. That is what keeps a view that re-reads on
    // every relayed notification from looping.
    const client = await createMcpClient();
    try {
      await client.callTool({ name: "notes__list", arguments: {} });
      await settle();

      expect(relayed).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

describe("resource listings scoped to one server", () => {
  const scoped = (source: string) => ({ _meta: { [RESOURCE_SOURCE_META_KEY]: source } });

  it("lists only the named server's resources, and passes its cursor through", async () => {
    const client = await createMcpClient();
    try {
      // `notes` holds one note from the relay test above; give it a second, and
      // give `other` one, so a scoped listing has something to leave out.
      await client.callTool({ name: "notes__save", arguments: {} });
      await client.callTool({ name: "other__save", arguments: {} });

      const first = await client.listResources(scoped("notes"));
      expect(first.resources.map((r) => r.uri)).toEqual(["notes://0"]);
      expect(first.nextCursor).toBe("1");

      const second = await client.listResources({ ...scoped("notes"), cursor: first.nextCursor });
      expect(second.resources.map((r) => r.uri)).toEqual(["notes://1"]);
      expect(second.nextCursor).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("lists only the named server's templates", async () => {
    const client = await createMcpClient();
    try {
      const result = await client.listResourceTemplates(scoped("other"));
      expect(result.resourceTemplates.map((t) => t.uriTemplate)).toEqual(["other://{index}"]);
    } finally {
      await client.close();
    }
  });

  it("a server that is not in the workspace lists as empty, not as an error", async () => {
    const client = await createMcpClient();
    try {
      expect((await client.listResources(scoped("absent"))).resources).toEqual([]);
      expect((await client.listResourceTemplates(scoped("absent"))).resourceTemplates).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("with no source named, an MCP client still gets the workspace-wide listing", async () => {
    const client = await createMcpClient();
    try {
      const uris = (await client.listResources()).resources.map((r) => r.uri);
      expect(uris).toContain("notes://0");
      expect(uris).toContain("other://0");
    } finally {
      await client.close();
    }
  });
});
