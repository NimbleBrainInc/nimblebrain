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
 * A `person` call made inside an unattended run carries `unattended: true`; a
 * `person` call to a tool the contract marks `grant: true`, with a workspace and
 * an owner and outside any run, carries the host's run grant for them (§6, §7).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import type { Transport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { EventSink, ToolResult } from "../engine/types.ts";
import { log } from "../observability/log.ts";
import { getRequestContext } from "../runtime/request-context.ts";
import type { RunGrantClaims } from "../runtime/run-grant.ts";
import { CONTRACT_SOURCE_NAMES } from "../tools/identity-sources.ts";
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
  /** The run grant, on a person call to a grant-marked tool. */
  grant?: string;
  /** True on every call made inside an unattended run. */
  unattended?: boolean;
}

/** The scope the kernel's own contract calls are walled to: a workspace, and an owner where the tool has one. */
export interface HostScope {
  workspaceId: string;
  ownerId?: string;
}

/** Signs the run grant a grant-marked call carries. */
export type GrantSigner = (claims: RunGrantClaims) => string;

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
  /** The version of the contract this kernel consumes: the `version` a private call sends. */
  hostVersion: string;
  /** The tool source agents, the door and the bridge reach the server through; it presents `person`. */
  source: McpSource;
  /** The contract's tools no call made inside an unattended run reaches, by bare name. */
  unattendedRefused: ReadonlySet<string>;
  /** The kernel's own call: presents `host` in `scope`. Throws {@link ContractToolError} on a tool error. */
  call(
    tool: string,
    args: Record<string, unknown>,
    scope: HostScope,
  ): Promise<Record<string, unknown>>;
  /**
   * Ask the server, as `host` in `scope`, to push `notifications/resources/updated`
   * for `uri` on its current connection: a `subscriptions/listen` of its own on a
   * 2026-07-28 connection, `resources/subscribe` on a 2025-era one. Resolves with
   * a close function, or null when the server cannot (not running, no
   * `resources.subscribe`, refused). A restarted server holds no subscription, so
   * a caller watches again when {@link connection} changes.
   */
  watch(uri: string, scope: HostScope): Promise<(() => Promise<void>) | null>;
  /** An identity for the server's current connection, which changes when it restarts. */
  connection(): object | null;
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
  if (host) {
    return {
      principal: "host",
      workspaceId: host.workspaceId,
      ...(host.ownerId ? { ownerId: host.ownerId } : {}),
    };
  }
  const ctx = getRequestContext();
  return {
    principal: "person",
    ...(ctx?.workspaceId ? { workspaceId: ctx.workspaceId } : {}),
    ...(ctx?.identity?.id ? { ownerId: ctx.identity.id } : {}),
    ...(ctx?.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(ctx?.unattended ? { unattended: true } : {}),
  };
}

type Message = Parameters<Transport["send"]>[0];

/** A JSON-RPC request (a method and an id); notifications and responses carry no context. */
function isRequest(message: Message): boolean {
  return "method" in message && "id" in message;
}

/** The tool a `tools/call` request names, or undefined for any other message. */
function calledTool(message: Message): string | undefined {
  if (!isRequest(message) || (message as { method?: unknown }).method !== "tools/call") return;
  const name = (message as { params?: { name?: unknown } }).params?.name;
  return typeof name === "string" ? name : undefined;
}

/**
 * The context `message` carries: the call path's, plus the run grant when it is
 * a `person` call to a grant-marked tool with a workspace and an owner, made
 * outside any run. A host call, another tool, and an unattended call never get
 * one, so no run obtains authority for another run.
 */
export function contextFor(
  message: Message,
  context: HostContext,
  grants: { contract: string; tools: ReadonlySet<string>; sign: GrantSigner } | undefined,
): HostContext {
  const tool = calledTool(message);
  if (
    !grants ||
    tool === undefined ||
    !grants.tools.has(tool) ||
    context.principal !== "person" ||
    context.unattended ||
    !context.workspaceId ||
    !context.ownerId
  ) {
    return context;
  }
  const grant = grants.sign({
    contract: grants.contract,
    workspaceId: context.workspaceId,
    ownerId: context.ownerId,
  });
  return { ...context, grant };
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
function stamped(
  transport: Transport,
  grants: { contract: string; tools: ReadonlySet<string>; sign: GrantSigner } | undefined,
): Transport {
  const send = transport.send.bind(transport);
  transport.send = (message, options) =>
    send(stampHostContext(message, contextFor(message, currentContext(), grants)), options);
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

/**
 * Facts only the host knows, laid over a bound server's tool results before
 * they reach agents, the door and apps, by contract: the kernel names the
 * contract whose results it completes, never the plugin.
 */
export type ResultOverlays = ReadonlyMap<
  string,
  (toolName: string, result: ToolResult) => ToolResult
>;

/** Start one binding's server and connect to it. */
async function startBoundServer(
  resolved: ResolvedPlugins,
  binding: ContractBinding,
  eventSink: EventSink,
  overlays: ResultOverlays,
  signGrant: GrantSigner | undefined,
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
  // The tool namespace is the kernel's, keyed by the contract it consumes; the
  // implementation's server key only says which server to launch.
  const sourceName = CONTRACT_SOURCE_NAMES.get(binding.contract);
  if (!sourceName) {
    throw new Error(`[plugins] ${name}: the runtime has no source name for ${binding.contract}`);
  }
  mkdirSync(plugin.dataDir, { recursive: true });
  const grantTools = new Set(binding.grantTools);
  if (grantTools.size > 0 && !signGrant) {
    throw new Error(
      `[plugins] ${name}: the contract marks grant tools and the runtime holds no grant key`,
    );
  }
  const grants = signGrant
    ? { contract: binding.contract, tools: grantTools, sign: signGrant }
    : undefined;
  const unattendedRefused = new Set(binding.unattendedRefused);

  const source = new McpSource(
    sourceName,
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
          grants,
        ),
      hiddenTools: new Set(binding.privateTools),
      refusedUnattended: unattendedRefused,
      // The public tools that author, start or stop work change what their
      // caller's views show.
      announceAfter: new Set(
        binding.unattendedRefused.filter((t) => !binding.privateTools.includes(t)),
      ),
      resultOverlay: overlays.get(binding.contract),
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

  async function watch(uri: string, scope: HostScope): Promise<(() => Promise<void>) | null> {
    const client = source.getClient();
    if (!client || source.getServerCapabilities()?.resources?.subscribe !== true) return null;
    try {
      return await hostCalls.run(scope, async () => {
        if (client.getProtocolEra() === "modern") {
          const subscription = await client.listen({ resourceSubscriptions: [uri] });
          return () => subscription.close();
        }
        await client.subscribeResource({ uri });
        return async () => {
          await client.unsubscribeResource({ uri }).catch(() => {});
        };
      });
    } catch (err) {
      log.warn(`[plugins] ${name} refused a watch of ${uri}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  log.info(`[plugins] started ${name} for ${binding.contract} ${binding.version}`);
  return {
    contract: binding.contract,
    plugin: binding.plugin,
    hostVersion: binding.hostVersion,
    source,
    unattendedRefused,
    call,
    watch,
    connection: () => source.getClient() ?? null,
  };
}

/**
 * Start the server of every binding in the resolved set, by contract. A
 * server that does not start refuses the boot, naming the contract, the
 * plugin and the server; the ones already started are stopped first.
 */
export async function startBoundServers(
  resolved: ResolvedPlugins,
  eventSink: EventSink,
  overlays: ResultOverlays = new Map(),
  signGrant?: GrantSigner,
): Promise<Map<string, BoundServer>> {
  const bound = new Map<string, BoundServer>();
  try {
    for (const binding of resolved.bindings) {
      bound.set(
        binding.contract,
        await startBoundServer(resolved, binding, eventSink, overlays, signGrant),
      );
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
