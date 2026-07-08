import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface FakeConnectorServer {
  url: string;
  close: () => void;
}

/**
 * A remote (Streamable-HTTP) MCP server exposing `toolNames` as no-op tools —
 * the personal-connector shape for tests. No auth: the `{type:"user"}` OAuth
 * provider is built but never challenged (the server answers 200), so
 * `getIdentityConnectorSource` lazy-starts it cleanly. Every `tools/call`
 * returns `ok`. `close()` stops the server.
 */
export function startFakeConnectorServer(toolNames: string[]): FakeConnectorServer {
  const makeServer = (): Server => {
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
  };

  let counter = 0;
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const httpServer = Bun.serve({
    port: 0,
    async fetch(req: Request) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
      const sid = req.headers.get("mcp-session-id");
      if (sid) {
        const existing = transports.get(sid);
        if (existing) return existing.handleRequest(req);
        return new Response("no session", { status: 404 });
      }
      // Fresh initialize → mint a session + transport.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => `sess-${++counter}`,
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      await makeServer().connect(transport);
      return transport.handleRequest(req);
    },
  });

  return {
    url: `http://localhost:${httpServer.port}/mcp`,
    close: () => httpServer.stop(true),
  };
}
