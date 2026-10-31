/**
 * A `ToolRouter` over the MCP servers an ACP client hands the agent at
 * `session/new`. The agent knows nothing of NimbleBrain's tool sources: it
 * reaches whatever the client exposed, the way any ACP agent would.
 */

import { Client, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import type { ContentBlock } from "@modelcontextprotocol/server";
import type { ToolCall, ToolResult, ToolRouter, ToolSchema } from "../../../src/engine/types.ts";
import type { McpChannel } from "../../../src/execution/tool-projection.ts";

/** An MCP server the agent was given, and how to reach it. */
export interface ReachableMcpServer {
  name: string;
  transport(): Transport;
}

/**
 * A projection's channel, reached directly: each MCP request goes to the
 * channel and its answer comes back as the response, with no ACP connection
 * between. Cancelling a request (`notifications/cancelled`) aborts it.
 */
export function channelMcpServer(name: string, channel: McpChannel): ReachableMcpServer {
  return {
    name,
    transport() {
      const inFlight = new Map<string, AbortController>();
      const transport: Transport = {
        async start() {},
        async close() {
          for (const controller of inFlight.values()) controller.abort();
          inFlight.clear();
          transport.onclose?.();
        },
        async send(message: JSONRPCMessage) {
          if (!("method" in message)) return; // a response to the server: this server asks nothing
          const params = ("params" in message ? message.params : undefined) as
            | Record<string, unknown>
            | undefined;
          if (!("id" in message)) {
            if (message.method === "notifications/cancelled") {
              inFlight.get(String((params as { requestId?: unknown })?.requestId))?.abort();
              return;
            }
            channel.notify(message.method, params);
            return;
          }
          const { id } = message;
          const controller = new AbortController();
          inFlight.set(String(id), controller);
          void channel
            .request(String(id), message.method, params, controller.signal)
            .then((answer) =>
              transport.onmessage?.(
                "error" in answer
                  ? { jsonrpc: "2.0", id, error: answer.error }
                  : { jsonrpc: "2.0", id, result: answer.result as Record<string, unknown> },
              ),
            )
            .finally(() => inFlight.delete(String(id)));
        },
      };
      return transport;
    },
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
