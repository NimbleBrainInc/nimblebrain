/**
 * `ai.nimblebrain/resource-arguments` on both protocol eras.
 *
 * The calling connector is an HTTP server (the SDK's `InMemoryTransport` links
 * 2025-era instances only): a 2025 server, a 2026-07-28 server, and a
 * 2026-07-28 server advertising the tasks extension, whose calls take the task
 * wire. Its tool declares a resource argument and echoes the `_meta` it was
 * called with. The serving connector is an in-process source the resolver reads
 * through `resources/read`. The same entries must arrive on every path, because
 * nothing travels from server to host.
 */
import { describe, expect, it } from "bun:test";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  InMemoryTransport,
  legacyStatelessFallback,
  Server,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import {
  createResourceArgumentsResolver,
  RESOURCE_ARGUMENTS_EXTENSION_ID,
  TokenBucketRateLimit,
} from "../../src/host-resources/index.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { TASKS_EXTENSION_ID } from "../../src/tools/mcp-task-client.ts";
import { isReservedResourceScheme } from "../../src/tools/resource-schemes.ts";

const WS = "ws_00000000000e7a01";
const SIGNAL = '{"id":42}';

type Fetch = (request: Request) => Promise<Response>;

function outboundServer(extensions?: ServerCapabilities["extensions"]): Server {
  const server = new Server(
    { name: "outbound", version: "1.0.0" },
    { capabilities: { tools: {}, ...(extensions ? { extensions } : {}) } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "cite",
        inputSchema: {
          type: "object" as const,
          properties: { citation: { type: "string" } },
        },
        _meta: {
          [RESOURCE_ARGUMENTS_EXTENSION_ID]: { arguments: { citation: { schemes: ["crm"] } } },
        },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async (request) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(request.params._meta?.[RESOURCE_ARGUMENTS_EXTENSION_ID] ?? null),
      },
    ],
  }));
  return server;
}

async function crmSource(): Promise<McpSource> {
  const source = new McpSource(
    "crm",
    {
      type: "inProcess",
      createServer: async () => {
        const server = new Server(
          { name: "crm", version: "1.0.0" },
          { capabilities: { resources: {} } },
        );
        server.setRequestHandler("resources/templates/list", async () => ({
          resourceTemplates: [{ uriTemplate: "crm://signals/{id}", name: "signal" }],
        }));
        server.setRequestHandler("resources/read", async (request) => ({
          contents: [{ uri: request.params.uri, mimeType: "application/json", text: SIGNAL }],
        }));
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        return { server, clientTransport };
      },
    },
    new NoopEventSink(),
  );
  await source.start();
  return source;
}

describe.each([
  {
    path: "a 2025-era connection",
    version: "2025-11-25",
    fetch: (): Fetch => legacyStatelessFallback(() => outboundServer()),
  },
  {
    path: "a 2026-07-28 connection",
    version: "2026-07-28",
    fetch: (): Fetch => createMcpHandler(() => outboundServer()).fetch,
  },
  {
    path: "the 2026-07-28 task wire",
    version: "2026-07-28",
    fetch: (): Fetch => createMcpHandler(() => outboundServer({ [TASKS_EXTENSION_ID]: {} })).fetch,
  },
])("resource arguments over $path", ({ version, fetch }) => {
  it("carries the resolved contents in the tools/call _meta, and the claim in the client capabilities", async () => {
    const handler = fetch();
    const claims: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "POST") {
          const body = (await request
            .clone()
            .json()
            .catch(() => null)) as {
            method?: string;
            params?: {
              capabilities?: { extensions?: Record<string, unknown> };
              _meta?: Record<string, { extensions?: Record<string, unknown> }>;
            };
          } | null;
          const caps =
            body?.method === "initialize"
              ? body.params?.capabilities
              : body?.params?._meta?.[CLIENT_CAPABILITIES_META_KEY];
          if (caps?.extensions?.[RESOURCE_ARGUMENTS_EXTENSION_ID]) {
            claims.push(caps.extensions[RESOURCE_ARGUMENTS_EXTENSION_ID]);
          }
        }
        return handler(request);
      },
    });

    const crm = await crmSource();
    const rateLimit = new TokenBucketRateLimit();
    const outbound = new McpSource(
      "outbound",
      {
        type: "remote",
        url: new URL(`http://localhost:${server.port}/mcp`),
        allowInsecure: true,
      },
      new NoopEventSink(),
      {
        workspaceId: WS,
        connectorId: "outbound",
        hostResources: {
          read: async () => ({ contents: [] }),
          list: async () => ({ resources: [] }),
        },
        rateLimit,
        resourceArguments: createResourceArgumentsResolver({
          sourcesOf: (wsId) => (wsId === WS ? [crm] : []),
          isHostScheme: isReservedResourceScheme,
          rateLimit,
        }),
      },
    );
    try {
      await outbound.start();
      expect(outbound.getNegotiatedProtocolVersion()).toBe(version);
      await outbound.tools();
      const result = await outbound.execute("cite", { citation: "crm://signals/42" });
      expect(result.isError).toBe(false);
      const text = result.content.find((c) => c.type === "text");
      expect(JSON.parse(text && "text" in text ? text.text : "null")).toEqual({
        "crm://signals/42": {
          contents: [{ uri: "crm://signals/42", mimeType: "application/json", text: SIGNAL }],
        },
      });
      expect(claims.length).toBeGreaterThan(0);
    } finally {
      await outbound.stop();
      await crm.stop();
      server.stop(true);
    }
  });
});

describe("resource arguments on a call made for an outside client", () => {
  it("sends the entries beside the client's capabilities in one _meta", async () => {
    const handler = createMcpHandler(() => outboundServer()).fetch;
    const callMetas: Record<string, unknown>[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (request.method === "POST") {
          const body = (await request
            .clone()
            .json()
            .catch(() => null)) as {
            method?: string;
            params?: { _meta?: Record<string, unknown> };
          } | null;
          if (body?.method === "tools/call" && body.params?._meta) {
            callMetas.push(body.params._meta);
          }
        }
        return handler(request);
      },
    });

    const crm = await crmSource();
    const rateLimit = new TokenBucketRateLimit();
    const outbound = new McpSource(
      "outbound",
      {
        type: "remote",
        url: new URL(`http://localhost:${server.port}/mcp`),
        allowInsecure: true,
      },
      new NoopEventSink(),
      {
        workspaceId: WS,
        connectorId: "outbound",
        hostResources: {
          read: async () => ({ contents: [] }),
          list: async () => ({ resources: [] }),
        },
        rateLimit,
        resourceArguments: createResourceArgumentsResolver({
          sourcesOf: (wsId) => (wsId === WS ? [crm] : []),
          isHostScheme: isReservedResourceScheme,
          rateLimit,
        }),
      },
    );
    try {
      await outbound.start();
      await outbound.tools();
      const capabilities = { elicitation: {} };
      const result = await outbound.execute("cite", { citation: "crm://signals/42" }, undefined, {
        caller: { capabilities },
      });
      expect(result.isError).toBe(false);
      const meta = callMetas.at(-1);
      expect(meta?.[CLIENT_CAPABILITIES_META_KEY]).toEqual(capabilities);
      expect(meta?.[RESOURCE_ARGUMENTS_EXTENSION_ID]).toEqual({
        "crm://signals/42": {
          contents: [{ uri: "crm://signals/42", mimeType: "application/json", text: SIGNAL }],
        },
      });
    } finally {
      await outbound.stop();
      await crm.stop();
      server.stop(true);
    }
  });
});
