/**
 * The runtime's outbound connection against servers built on old MCP SDKs.
 *
 * Connectors the runtime reaches are third-party servers, and many are built on
 * an MCP TypeScript SDK long behind the one the runtime uses. An SDK upgrade on
 * this side must not drop them. Each case here is a real server from a pinned
 * old SDK (installed under an alias), reached through `McpSource` with the
 * transport a connector's config selects, and checked end to end: it connects,
 * negotiates a version the old server speaks, lists its tools, and calls one.
 *
 * - SDK 1.0.4: protocol 2024-11-05, SSE only (it predates Streamable HTTP).
 * - SDK 1.10.2: protocol 2024-11-05 still, with Streamable HTTP added beside SSE.
 * - SDK 1.13.3: protocol 2025-06-18, SSE and Streamable HTTP.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";

interface OldSdk {
  label: string;
  /** The transports this SDK can serve; 1.0 predates Streamable HTTP. */
  transports: ReadonlyArray<"sse" | "streamable">;
  /** The protocol version the server answers with. */
  version: string;
  load: () => Promise<{
    // biome-ignore lint/suspicious/noExplicitAny: each old SDK has its own Server and schema types
    Server: any;
    // biome-ignore lint/suspicious/noExplicitAny: as above
    types: any;
    // biome-ignore lint/suspicious/noExplicitAny: as above
    SSEServerTransport: any;
    // biome-ignore lint/suspicious/noExplicitAny: absent before SDK 1.10
    Streamable: any | null;
  }>;
}

const SDKS: OldSdk[] = [
  {
    label: "SDK 1.0.4",
    transports: ["sse"],
    version: "2024-11-05",
    load: async () => ({
      Server: (await import("mcp-sdk-v1-0/server/index.js")).Server,
      types: await import("mcp-sdk-v1-0/types.js"),
      SSEServerTransport: (await import("mcp-sdk-v1-0/server/sse.js")).SSEServerTransport,
      Streamable: null,
    }),
  },
  {
    label: "SDK 1.10.2",
    transports: ["sse", "streamable"],
    version: "2024-11-05",
    load: async () => ({
      Server: (await import("mcp-sdk-v1-10/server/index.js")).Server,
      types: await import("mcp-sdk-v1-10/types.js"),
      SSEServerTransport: (await import("mcp-sdk-v1-10/server/sse.js")).SSEServerTransport,
      Streamable: (await import("mcp-sdk-v1-10/server/streamableHttp.js"))
        .StreamableHTTPServerTransport,
    }),
  },
  {
    label: "SDK 1.13.3",
    transports: ["sse", "streamable"],
    version: "2025-06-18",
    load: async () => ({
      Server: (await import("mcp-sdk-v1-13/server/index.js")).Server,
      types: await import("mcp-sdk-v1-13/types.js"),
      SSEServerTransport: (await import("mcp-sdk-v1-13/server/sse.js")).SSEServerTransport,
      Streamable: (await import("mcp-sdk-v1-13/server/streamableHttp.js"))
        .StreamableHTTPServerTransport,
    }),
  },
];

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

// biome-ignore lint/suspicious/noExplicitAny: the loaded SDK's module shape
function buildServer(sdk: any) {
  const server = new sdk.Server({ name: "old", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(sdk.types.ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo the input back.",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
    ],
  }));
  server.setRequestHandler(
    sdk.types.CallToolRequestSchema,
    async (request: { params: { arguments?: { text?: string } } }) => ({
      content: [{ type: "text", text: `echo:${request.params.arguments?.text ?? ""}` }],
    }),
  );
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : undefined;
}

/** Serve an old SDK over SSE (`GET /sse`, `POST /messages`) or Streamable HTTP (`/mcp`). */
async function serve(
  sdk: Awaited<ReturnType<OldSdk["load"]>>,
  mode: "sse" | "streamable",
): Promise<string> {
  // biome-ignore lint/suspicious/noExplicitAny: the loaded SDK's transport
  const transports = new Map<string, any>();
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (mode === "sse") {
      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new sdk.SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        await buildServer(sdk).connect(transport);
        return;
      }
      if (req.method === "POST" && url.pathname === "/messages") {
        const transport = transports.get(url.searchParams.get("sessionId") ?? "");
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
      let transport = typeof sid === "string" ? transports.get(sid) : undefined;
      if (!transport) {
        transport = new sdk.Streamable({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => transports.set(id, transport),
        });
        await buildServer(sdk).connect(transport);
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

describe("the runtime reaches servers on old MCP SDKs", () => {
  for (const old of SDKS) {
    for (const mode of old.transports) {
      it(`${old.label} over ${mode === "sse" ? "SSE" : "Streamable HTTP"}`, async () => {
        const sdk = await old.load();
        const url = await serve(sdk, mode);
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
          expect(source.getNegotiatedProtocolVersion()).toBe(old.version);
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
  }
});
