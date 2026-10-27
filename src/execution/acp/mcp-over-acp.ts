/**
 * MCP carried on the ACP connection (the MCP-over-ACP proposal, ADR-0057).
 *
 * The client declares an MCP server with the `acp` transport by id; the agent
 * sends each MCP message for it back as `mcp/message` on the connection the
 * runtime dialed, and the client answers it. Nothing listens, and the only way
 * to the run's tools is the connection itself.
 *
 * A server id is random per run and never reused, because a connection may
 * carry many people's turns: a session must not be able to name another's
 * server. It is bound before `session/new` declares it, since a message can
 * arrive before that call returns.
 */

import { randomBytes } from "node:crypto";
import * as acp from "@agentclientprotocol/sdk/unstable";
import type { McpChannel } from "../tool-projection.ts";

/** The ACP method that carries one MCP message, in either direction. */
export const MCP_MESSAGE = "mcp/message";

/** One `mcp/message` from the agent: an inner MCP request or notification for a declared server. */
export interface McpMessage {
  serverId: string;
  requestId?: string;
  method: string;
  params?: Record<string, unknown>;
}

/** The `acp` MCP servers declared on one connection, by id. */
export interface AcpMcpServers {
  /** Bind `channel` under a new random id, and return the server entry to declare. */
  declare(name: string, channel: McpChannel): acp.McpServer;
  /** Register the `mcp/message` handlers on a client app. */
  serve(app: acp.ClientApp): acp.ClientApp;
}

export function createAcpMcpServers(): AcpMcpServers {
  const servers = new Map<string, McpChannel>();
  const channelFor = (serverId: string): McpChannel => {
    const channel = servers.get(serverId);
    if (!channel) throw acp.RequestError.invalidParams(undefined, "unknown MCP server");
    return channel;
  };
  return {
    declare(name, channel) {
      const serverId = `nb_${randomBytes(16).toString("hex")}`;
      servers.set(serverId, channel);
      return { type: "acp", name, serverId };
    },
    serve(app) {
      return app
        .onRequest(MCP_MESSAGE, parseMcpMessage, (ctx) => {
          const { serverId, requestId, method, params } = ctx.params;
          if (requestId === undefined) {
            throw acp.RequestError.invalidParams(undefined, "mcp/message needs a requestId");
          }
          return channelFor(serverId).request(requestId, method, params, ctx.signal);
        })
        .onNotification(MCP_MESSAGE, parseMcpMessage, (ctx) => {
          const { serverId, method, params } = ctx.params;
          servers.get(serverId)?.notify(method, params);
        });
    },
  };
}

/** An `mcp/message`'s params, or an invalid-params error. */
export function parseMcpMessage(raw: unknown): McpMessage {
  const p = (raw ?? {}) as Record<string, unknown>;
  const { serverId, requestId, method, params } = p;
  if (typeof serverId !== "string" || typeof method !== "string") {
    throw acp.RequestError.invalidParams(undefined, "mcp/message needs a serverId and a method");
  }
  if (requestId !== undefined && requestId !== null && typeof requestId !== "string") {
    throw acp.RequestError.invalidParams(undefined, "mcp/message requestId must be a string");
  }
  if (
    params !== undefined &&
    params !== null &&
    (typeof params !== "object" || Array.isArray(params))
  ) {
    throw acp.RequestError.invalidParams(undefined, "mcp/message params must be an object");
  }
  return {
    serverId,
    method,
    ...(typeof requestId === "string" ? { requestId } : {}),
    ...(params ? { params: params as Record<string, unknown> } : {}),
  };
}
