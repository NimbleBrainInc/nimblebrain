/**
 * An MCP server the test can point an `McpSource` at over a URL.
 *
 * The runtime connects to MCP servers over a network and nothing else
 * (ADR-0020), so `remote` is the only mode a connector test can exercise
 * that resembles production. This helper is the shared Streamable-HTTP
 * server behind those tests: it mints a session + transport per
 * `initialize`, routes subsequent requests by `mcp-session-id`, and hands
 * back a `http://localhost:<port>/mcp` URL.
 *
 * `makeServer` is a factory, not a `Server`, because a `Server` claims its
 * transport permanently — every session needs its own.
 *
 * A test whose subject is the *host* side of the transport rather than the
 * connector (a platform capability, an in-process app) wants
 * `makeInProcessSource` instead: an in-process source is a trust boundary
 * of its own (ADR-0022) and host-owned `_meta` markers survive it.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export interface RemoteMcpFixture {
  /** Pass to an `McpSource` as `{ type: "remote", url: new URL(url), allowInsecure: true }`. */
  url: string;
  /**
   * Drop every live session. The next request carrying an old session id
   * gets the wire shape a rolled server emits — HTTP 404 with a
   * `-32600 Session not found` body.
   */
  roll: () => void;
  close: () => void;
}

export function startRemoteMcpServer(makeServer: () => Server): RemoteMcpFixture {
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
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "server-error",
            error: { code: -32600, message: "Session not found" },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }

      // No session id → a fresh `initialize`. Mint a session + transport.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => `sess-${++counter}`,
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      await makeServer().connect(transport);
      return transport.handleRequest(req);
    },
  });

  const dropSessions = () => {
    for (const t of transports.values()) t.close().catch(() => {});
    transports.clear();
  };

  return {
    url: `http://localhost:${httpServer.port}/mcp`,
    roll: dropSessions,
    close() {
      httpServer.stop(true);
      dropSessions();
    },
  };
}
