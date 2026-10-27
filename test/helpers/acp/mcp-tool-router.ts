/**
 * A `ToolRouter` over the MCP servers an ACP client hands the agent at
 * `session/new`. The agent knows nothing of NimbleBrain's tool sources: it
 * reaches whatever the client exposed, the way any ACP agent would.
 */

import {
  Client,
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import type { ContentBlock } from "@modelcontextprotocol/server";
import type { ToolCall, ToolResult, ToolRouter, ToolSchema } from "../../../src/engine/types.ts";

/** An MCP server the agent was given, and how to reach it. */
export interface ReachableMcpServer {
  name: string;
  transport(): Transport;
}

/** An ACP `McpServer` of the HTTP shape, reached over Streamable HTTP. */
export function httpMcpServer(server: {
  name: string;
  url: string;
  headers: { name: string; value: string }[];
}): ReachableMcpServer {
  const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]));
  return {
    name: server.name,
    transport: () =>
      new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
  };
}

export interface McpToolRouter extends ToolRouter {
  close(): Promise<void>;
}

export async function connectMcpToolRouter(servers: ReachableMcpServer[]): Promise<McpToolRouter> {
  const connections: { client: Client; tools: ToolSchema[] }[] = [];
  const owner = new Map<string, Client>();
  try {
    for (const server of servers) {
      const client = new Client(
        { name: "scripted-acp-agent", version: "1" },
        { capabilities: {}, versionNegotiation: { mode: "auto" } },
      );
      await client.connect(server.transport());
      const listed = await client.listTools();
      const tools = listed.tools.map(
        (t): ToolSchema => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema as Record<string, unknown>,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        }),
      );
      for (const tool of tools) {
        if (owner.has(tool.name)) {
          throw new Error(`Tool ${tool.name} is served by more than one MCP server`);
        }
        owner.set(tool.name, client);
      }
      connections.push({ client, tools });
    }
  } catch (err) {
    await Promise.allSettled(connections.map((c) => c.client.close()));
    throw err;
  }

  const allTools = connections.flatMap((c) => c.tools);
  return {
    availableTools: async () => allTools,
    async execute(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
      const client = owner.get(call.name);
      if (!client) {
        return { content: [{ type: "text", text: `Unknown tool: ${call.name}` }], isError: true };
      }
      const result = await client.callTool(
        { name: call.name, arguments: call.input },
        signal ? { signal } : undefined,
      );
      return {
        content: (result.content ?? []) as ContentBlock[],
        isError: result.isError === true,
        ...(result.structuredContent
          ? { structuredContent: result.structuredContent as Record<string, unknown> }
          : {}),
      };
    },
    async close() {
      await Promise.allSettled(connections.map((c) => c.client.close()));
    },
  };
}
