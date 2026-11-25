/**
 * The servers the kernel binds to the contracts it consumes (ADR-0076): each
 * started from its plugin's `mcp.json`, held as one MCP connection, and
 * reached two ways.
 *
 * - **The kernel's own contract client** (`BoundServer.call`) presents
 *   `host`. It alone can: the scope it runs calls under lives in this module
 *   and nothing exports it.
 * - **Everything else** reaches the server through its tool source
 *   (`BoundServer.source`): agents through the ToolRouter, MCP clients at the
 *   door, MCP Apps through the bridge. Each request presents `person`, with
 *   the workspace, owner and conversation the runtime verified for it. The
 *   source never lists the contract's private tools and refuses to call them.
 *
 * Every request to the server passes through one transport `send`, which sets
 * `params._meta["ai.nimblebrain/context"]` after every other `_meta` merge and
 * overwrites whatever a caller put there (`contracts/host-context/CONTEXT.md`).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import type { Transport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { EventSink } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import { getRequestContext } from "../runtime/request-context.ts";
import { McpSource } from "../tools/mcp-source.ts";
import type { ContractBinding } from "./contracts.ts";
import type { ResolvedPlugins } from "./index.ts";

/** Where a request carries its host context. */
export const HOST_CONTEXT_META_KEY = "ai.nimblebrain/context";

/** The host context (`schemas/host-context/v1/host-context.schema.json`). */
export interface HostContext {
  principal: "host" | "person";
  workspaceId?: string;
  ownerId?: string;
  conversationId?: string;
}

/** The scope the kernel's own contract calls are walled to. */
export interface HostScope {
  workspaceId: string;
  ownerId: string;
}

/** A contract tool's `{ code, error }` failure, as the server answered it. */
export class ContractToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContractToolError";
  }
}

/** A server bound to a contract, started and connected. */
export interface BoundServer {
  contract: string;
  plugin: string;
  /** The tool source agents, the door and the bridge reach the server through; it presents `person`. */
  source: McpSource;
  /** The kernel's own call: presents `host` in `scope`. Throws {@link ContractToolError} on a tool error. */
  call(
    tool: string,
    args: Record<string, unknown>,
    scope: HostScope,
  ): Promise<Record<string, unknown>>;
}

/** The scope of the kernel's own contract call in flight. Never exported. */
const hostCalls = new AsyncLocalStorage<HostScope>();

/**
 * The context of the request being sent now: `host` inside the kernel's own
 * contract client, `person` otherwise, with only the dimensions the runtime
 * verified (the request's workspace, its signed-in identity, the turn's
 * conversation).
 */
function currentContext(): HostContext {
  const host = hostCalls.getStore();
  if (host) return { principal: "host", workspaceId: host.workspaceId, ownerId: host.ownerId };
  const ctx = getRequestContext();
  return {
    principal: "person",
    ...(ctx?.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    ...(ctx?.identity?.id ? { ownerId: ctx.identity.id } : {}),
    ...(ctx?.conversationId ? { conversationId: ctx.conversationId } : {}),
  };
}

type Message = Parameters<Transport["send"]>[0];

/** A JSON-RPC request (a method and an id); notifications and responses carry no context. */
function isRequest(message: Message): boolean {
  return "method" in message && "id" in message;
}

/** `message` with `context` at `params._meta["ai.nimblebrain/context"]`, replacing any value there. */
export function stampHostContext(message: Message, context: HostContext): Message {
  if (!isRequest(message)) return message;
  const request = message as { params?: Record<string, unknown> };
  const params = request.params ?? {};
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  return {
    ...message,
    params: { ...params, _meta: { ...meta, [HOST_CONTEXT_META_KEY]: context } },
  } as Message;
}

/** `transport`, with every request it sends stamped with the context of the call that sent it. */
function stamped(transport: Transport): Transport {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(stampHostContext(message, currentContext()), options);
  return transport;
}

/** The `{ code, error }` text of a tool error result. */
function toolErrorOf(result: { content?: unknown }): ContractToolError {
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = (first as { text?: unknown } | undefined)?.text;
  try {
    const { code, error } = JSON.parse(typeof text === "string" ? text : "{}") as {
      code?: unknown;
      error?: unknown;
    };
    if (typeof code === "string") return new ContractToolError(code, String(error ?? code));
  } catch {
    // Not the contract's shape; reported as it is below.
  }
  return new ContractToolError("internal_error", typeof text === "string" ? text : "tool error");
}

/** Start one binding's server and connect to it. */
async function startBoundServer(
  resolved: ResolvedPlugins,
  binding: ContractBinding,
  eventSink: EventSink,
): Promise<BoundServer> {
  const name = `${binding.contract}: the ${binding.plugin} plugin's server "${binding.server}"`;
  const plugin = resolved.plugins.find((p) => p.name === binding.plugin);
  const server = plugin?.servers[binding.server];
  if (!plugin || !server) throw new Error(`[plugins] ${name} is not in the resolved set`);
  // A server the operator placed at a URL needs the host's credential for it
  // and a remote transport; the kernel binds only a server it starts.
  if (server.url) {
    throw new Error(
      `[plugins] ${name} is placed at ${server.url}; the runtime binds a contract only to a server it starts (remove servers.${binding.server}.url)`,
    );
  }
  const spec = server.spec;
  if (spec?.type !== "stdio") {
    throw new Error(`[plugins] ${name} is not a stdio server the runtime can start`);
  }
  mkdirSync(plugin.dataDir, { recursive: true });

  const source = new McpSource(
    binding.server,
    {
      type: "plugin",
      // A minimal environment (the SDK's default: PATH, HOME, USER and the
      // like) plus the server's own `env`, never the runtime's.
      createTransport: () =>
        stamped(
          new StdioClientTransport({
            command: spec.command,
            args: spec.args,
            env: { ...getDefaultEnvironment(), ...spec.env },
            cwd: spec.cwd,
            stderr: "inherit",
          }),
        ),
      hiddenTools: new Set(binding.privateTools),
    },
    eventSink,
  );
  try {
    await source.start();
  } catch (err) {
    throw new Error(
      `[plugins] ${name} did not start: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  async function call(
    tool: string,
    args: Record<string, unknown>,
    scope: HostScope,
  ): Promise<Record<string, unknown>> {
    // A server that exited is started again for the next call; one stopped at
    // shutdown stays stopped. A call that was in flight when it exited is not
    // retried: its write may have landed.
    if (!source.isAlive() && (source.isStopped() || !(await source.restart()))) {
      throw new Error(`[plugins] ${name} is not running`);
    }
    const client = source.getClient();
    if (!client) throw new Error(`[plugins] ${name} is not running`);
    const result = (await hostCalls.run(scope, () =>
      client.callTool({ name: tool, arguments: args }),
    )) as { isError?: boolean; content?: unknown; structuredContent?: unknown };
    if (result.isError) throw toolErrorOf(result);
    return (result.structuredContent ?? {}) as Record<string, unknown>;
  }

  log.info(`[plugins] started ${name} for ${binding.contract} ${binding.version}`);
  return { contract: binding.contract, plugin: binding.plugin, source, call };
}

/**
 * Start the server of every binding in the resolved set, by contract. A
 * server that does not start refuses the boot, naming the contract, the
 * plugin and the server; the ones already started are stopped first.
 */
export async function startBoundServers(
  resolved: ResolvedPlugins,
  eventSink: EventSink,
): Promise<Map<string, BoundServer>> {
  const bound = new Map<string, BoundServer>();
  try {
    for (const binding of resolved.bindings) {
      bound.set(binding.contract, await startBoundServer(resolved, binding, eventSink));
    }
  } catch (err) {
    await stopBoundServers(bound);
    throw err;
  }
  return bound;
}

/** Stop every bound server. */
export async function stopBoundServers(bound: ReadonlyMap<string, BoundServer>): Promise<void> {
  for (const server of bound.values()) await server.source.stop();
}
