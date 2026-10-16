/**
 * The runtime's outbound connection against a server on the 2025 era.
 *
 * Connectors the runtime reaches are third-party servers, and many still speak
 * 2025-11-25 over an MCP TypeScript SDK v1 server, while the runtime is on SDK
 * 2 and prefers 2026-07-28. The runtime must keep reaching them: it probes with
 * `server/discover`, gets no 2026 answer, and falls back to `initialize`. The
 * server here is a real SDK v1 release (installed under the `mcp-sdk-v1`
 * alias), reached through `McpSource` with the transport a connector's config
 * selects, and checked end to end: it connects, negotiates 2025-11-25, lists
 * its tools, and calls one. Both transports are covered, because 2025-era
 * connectors are still found on SSE as well as Streamable HTTP.
 *
 * The expected version is the point of the test, not an incidental pin: if a
 * later SDK v1 release answers with another revision, this fails, and the
 * alias is held at the last release that speaks 2025-11-25.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as SdkServer } from "mcp-sdk-v1/server/index.js";
import { SSEServerTransport } from "mcp-sdk-v1/server/sse.js";
import { StreamableHTTPServerTransport } from "mcp-sdk-v1/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "mcp-sdk-v1/types.js";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

const ERA_2025 = "2025-11-25";

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

function buildServer() {
  const server = new SdkServer({ name: "old", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo the input back.",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `echo:${request.params.arguments?.text ?? ""}` }],
  }));
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : undefined;
}

/** Serve SDK v1 over SSE (`GET /sse`, `POST /messages`) or Streamable HTTP (`/mcp`). */
async function serve(mode: "sse" | "streamable"): Promise<string> {
  const sse = new Map<string, SSEServerTransport>();
  const streamable = new Map<string, StreamableHTTPServerTransport>();
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (mode === "sse") {
      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        sse.set(transport.sessionId, transport);
        await buildServer().connect(transport);
        return;
      }
      if (req.method === "POST" && url.pathname === "/messages") {
        const transport = sse.get(url.searchParams.get("sessionId") ?? "");
        if (!transport) {
          res.writeHead(404).end();
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
    } else if (url.pathname === "/mcp") {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      const sid = req.headers["mcp-session-id"];
      let transport = typeof sid === "string" ? streamable.get(sid) : undefined;
      if (!transport) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            streamable.set(id, created);
          },
        });
        await buildServer().connect(created);
        transport = created;
      }
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(404).end();
  };
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return mode === "sse" ? `http://127.0.0.1:${port}/sse` : `http://127.0.0.1:${port}/mcp`;
}

describe("the runtime reaches a 2025-era server on MCP SDK v1", () => {
  for (const mode of ["sse", "streamable"] as const) {
    it(`over ${mode === "sse" ? "SSE" : "Streamable HTTP"}`, async () => {
      const url = await serve(mode);
      const source = new McpSource(
        "old",
        {
          type: "remote",
          url: new URL(url),
          transportConfig: { type: mode === "sse" ? "sse" : "streamable-http" },
          allowInsecure: true,
        },
        new NoopEventSink(),
      );
      try {
        await source.start();
        expect(source.getNegotiatedProtocolVersion()).toBe(ERA_2025);
        const tools = await source.tools();
        expect(tools.map((t) => t.name)).toEqual(["old__echo"]);
        const result = await source.execute("echo", { text: "hi" });
        expect(result.isError).toBeFalsy();
        expect(JSON.stringify(result.content)).toContain("echo:hi");
      } finally {
        await source.stop();
      }
    });
  }
});
