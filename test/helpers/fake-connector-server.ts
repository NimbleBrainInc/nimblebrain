import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type RemoteMcpFixture, startRemoteMcpServer } from "./remote-mcp-fixture.ts";

export type FakeConnectorServer = RemoteMcpFixture;

/**
 * A remote (Streamable-HTTP) MCP server exposing `toolNames` as no-op tools —
 * the personal-connector shape for tests. No auth: the `{type:"user"}` OAuth
 * provider is built but never challenged (the server answers 200), so
 * `getIdentityConnectorSource` lazy-starts it cleanly. Every `tools/call`
 * returns `ok`. `close()` stops the server.
 */
export function startFakeConnectorServer(toolNames: string[]): FakeConnectorServer {
  return startRemoteMcpServer(() => {
    const server = new Server(
      { name: "fake-connector", version: "0.1.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: toolNames.map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object", properties: {} },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    return server;
  });
}
