/**
 * The bridge (ADR-0057): the CLIs take only HTTP MCP servers, and NimbleBrain
 * gives a session its tools over the ACP connection (`acp` MCP transport). So
 * each session gets a loopback MCP endpoint on this worker, and every MCP
 * message the CLI posts there is relayed to the runtime as `mcp/message` on
 * the session's own ACP connection. The runtime's tool projection answers it,
 * with all of a run's checks; the worker holds no tool and no credential.
 *
 * The endpoint's path carries a random token per session, and it is served on
 * loopback only, so only a process on this machine that was told the URL can
 * reach it, and only for the life of the session.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type * as acp from "@agentclientprotocol/sdk/unstable";

export const MCP_MESSAGE = "mcp/message";
export const BRIDGE_PATH = "/mcp/";

interface Binding {
  client: acp.AgentContext;
  serverId: string;
}

type McpAnswer =
  | { result: Record<string, unknown> }
  | { error: { code: number; message: string; data?: unknown } };

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface Bridge {
  /** Serve `serverId` on `client`'s connection at a new loopback URL; `release` ends it. */
  bind(client: acp.AgentContext, serverId: string): { url: string; release(): void };
  /** Handle a request under `BRIDGE_PATH`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createBridge(baseUrl: () => string): Bridge {
  const bindings = new Map<string, Binding>();
  return {
    bind(client, serverId) {
      const token = randomBytes(24).toString("hex");
      bindings.set(token, { client, serverId });
      return { url: `${baseUrl()}${BRIDGE_PATH}${token}`, release: () => bindings.delete(token) };
    },
    async handle(req, res) {
      const token = (req.url ?? "").slice(BRIDGE_PATH.length).split(/[/?]/)[0] ?? "";
      const binding = bindings.get(token);
      if (!binding) return reply(res, 404);
      // No server-initiated stream: every answer rides its POST.
      if (req.method === "DELETE") return reply(res, 200);
      if (req.method !== "POST") return reply(res, 405);
      return post(binding, req, res);
    },
  };
}

/** A POST of one MCP message or a batch: each relayed, the answers on the response. */
async function post(binding: Binding, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: JsonRpcMessage | JsonRpcMessage[];
  try {
    body = JSON.parse(await readBody(req)) as JsonRpcMessage | JsonRpcMessage[];
  } catch {
    return reply(res, 400);
  }
  const messages = Array.isArray(body) ? body : [body];
  const answers = (await Promise.all(messages.map((m) => relay(binding, m)))).filter(
    (a): a is Record<string, unknown> => a !== undefined,
  );
  if (answers.length === 0) return reply(res, 202);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(Array.isArray(body) ? answers : answers[0]));
}

/** One MCP message to the runtime; a request's answer, or nothing for a notification. */
async function relay(
  { client, serverId }: Binding,
  message: JsonRpcMessage,
): Promise<Record<string, unknown> | undefined> {
  if (!message.method) return undefined;
  if (message.id === undefined || message.id === null) {
    await client.notify(MCP_MESSAGE, { serverId, method: message.method, params: message.params });
    return undefined;
  }
  const { id } = message;
  try {
    const answer = await client.request<McpAnswer>(MCP_MESSAGE, {
      serverId,
      requestId: String(id),
      method: message.method,
      ...(message.params ? { params: message.params } : {}),
    });
    return { jsonrpc: "2.0", id, ...answer };
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number): void {
  res.writeHead(status);
  res.end();
}
