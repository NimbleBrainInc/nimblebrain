/**
 * An MCP client transport over an ACP connection: the agent side of MCP over
 * ACP. Each MCP request goes to the client as an `mcp/message` request for the
 * declared server, and its answer comes back as that request's response; a
 * notification goes as an `mcp/message` notification. Cancelling a request
 * (`notifications/cancelled`) cancels the `mcp/message` carrying it.
 */

import type * as acp from "@agentclientprotocol/sdk/unstable";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";

const MCP_MESSAGE = "mcp/message";

type Answer =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string; data?: unknown } };

export function acpMcpClientTransport(client: acp.AgentContext, serverId: string): Transport {
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
      const params = "params" in message ? message.params : undefined;
      if (!("id" in message)) {
        if (message.method === "notifications/cancelled") {
          const id = String((params as { requestId?: unknown } | undefined)?.requestId);
          inFlight.get(id)?.abort();
          return;
        }
        await client.notify(MCP_MESSAGE, { serverId, method: message.method, params });
        return;
      }
      const id = message.id;
      const requestId = String(id);
      const controller = new AbortController();
      inFlight.set(requestId, controller);
      void client
        .request<Answer>(
          MCP_MESSAGE,
          { serverId, requestId, method: message.method, params },
          { cancellationSignal: controller.signal },
        )
        .then((answer) =>
          transport.onmessage?.(
            "error" in answer
              ? { jsonrpc: "2.0", id, error: answer.error }
              : { jsonrpc: "2.0", id, result: answer.result },
          ),
        )
        .catch((err) =>
          transport.onmessage?.({
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          }),
        )
        .finally(() => inFlight.delete(requestId));
    },
  };
  return transport;
}
