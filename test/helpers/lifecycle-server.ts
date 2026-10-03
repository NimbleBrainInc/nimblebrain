/**
 * A test MCP server that declares lifecycle handlers the way the
 * `ai.nimblebrain/lifecycle` extension specifies: it advertises the extension
 * in its capabilities (or deliberately does not) and marks handler tools with
 * `_meta["ai.nimblebrain/lifecycle"]`. Every `tools/call` is recorded with its
 * arguments and whether it asked for a task.
 *
 * Two eras: in-process over `InMemoryTransport`, a 2025-era connection whose
 * `initialize` result carries the `extensions` map; and over HTTP through the
 * SDK's `createMcpHandler`, a 2026-07-28 connection that carries it in
 * `server/discover`.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  createMcpHandler,
  InMemoryTransport,
  Server,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import { NoopEventSink } from "../../src/adapters/noop-events.ts";
import { LIFECYCLE_EXTENSION_ID } from "../../src/services/lifecycle-extension.ts";
import { McpSource } from "../../src/tools/mcp-source.ts";
import { TASKS_EXTENSION_ID } from "../../src/tools/mcp-task-client.ts";

/** A tool as the fixture lists it. */
export interface FixtureTool {
  name: string;
  /** The `event` the marker names; no marker when absent. */
  event?: string;
  /** `inputSchema.properties`. Default: none. */
  properties?: Record<string, Record<string, string>>;
  required?: string[];
  taskSupport?: "optional" | "required";
}

/** One `tools/call` the fixture answered. */
export interface FixtureCall {
  tool: string;
  args: Record<string, unknown>;
  /** Whether the request asked for task augmentation, on either era. */
  task: boolean;
}

export interface LifecycleServerOptions {
  /** Whether the server advertises the extension. Default: true. */
  advertises?: boolean;
  /** Advertise the 2026-07-28 tasks extension too. */
  tasks?: boolean;
  tools: FixtureTool[];
}

/** A tool marked for `event`, with no arguments. */
export function marked(name: string, event: string, extra: Partial<FixtureTool> = {}): FixtureTool {
  return { name, event, ...extra };
}

/** Record one `tools/call` from its params, `_meta` included. */
function record(calls: FixtureCall[], params: Record<string, unknown> | undefined): void {
  const meta = params?._meta as Record<string, unknown> | undefined;
  const claimed = meta?.[CLIENT_CAPABILITIES_META_KEY] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  calls.push({
    tool: String(params?.name),
    args: (params?.arguments as Record<string, unknown> | undefined) ?? {},
    task: params?.task !== undefined || claimed?.extensions?.[TASKS_EXTENSION_ID] !== undefined,
  });
}

/**
 * The fixture server. `calls` records each `tools/call` as the handler sees
 * it; pass `null` where the caller records from the raw request instead.
 */
function buildServer(
  name: string,
  opts: LifecycleServerOptions,
  calls: FixtureCall[] | null,
): Server {
  const extensions: NonNullable<ServerCapabilities["extensions"]> = {};
  if (opts.advertises ?? true) extensions[LIFECYCLE_EXTENSION_ID] = {};
  if (opts.tasks) extensions[TASKS_EXTENSION_ID] = {};
  const capabilities: ServerCapabilities = {
    tools: {},
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };
  const server = new Server({ name, version: "1.0.0" }, { capabilities });
  server.setRequestHandler("tools/list", async () => ({
    tools: opts.tools.map((t) => ({
      name: t.name,
      description: `Fixture ${t.name}.`,
      inputSchema: {
        type: "object" as const,
        properties: t.properties ?? {},
        ...(t.required ? { required: t.required } : {}),
      },
      ...(t.taskSupport ? { execution: { taskSupport: t.taskSupport } } : {}),
      ...(t.event ? { _meta: { [LIFECYCLE_EXTENSION_ID]: { event: t.event } } } : {}),
    })),
  }));
  server.setRequestHandler("tools/call", async (request) => {
    if (calls) record(calls, request.params as Record<string, unknown>);
    return { content: [{ type: "text", text: `${request.params.name} ok` }] };
  });
  return server;
}

/** A started 2025-era in-process source for the fixture, and the calls it answers. */
export async function startLifecycleSource(
  name: string,
  opts: LifecycleServerOptions,
): Promise<{ source: McpSource; calls: FixtureCall[] }> {
  const calls: FixtureCall[] = [];
  const source = new McpSource(
    name,
    {
      type: "inProcess",
      createServer: async () => {
        const server = buildServer(name, opts, calls);
        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        return { server, clientTransport };
      },
    },
    new NoopEventSink(),
  );
  await source.start();
  return { source, calls };
}

/** The fixture served over HTTP on 2026-07-28, and the calls it answers. */
export function serveModernLifecycleServer(
  name: string,
  opts: LifecycleServerOptions,
): { url: string; calls: FixtureCall[]; close: () => void } {
  const calls: FixtureCall[] = [];
  const handler = createMcpHandler(() => buildServer(name, opts, null));
  // Recorded from the raw request: on 2026-07-28 the per-request client
  // capabilities, where a task is claimed, ride `_meta`, which the server SDK
  // strips before a handler sees the params.
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (request.method === "POST") {
        const body = (await request
          .clone()
          .json()
          .catch(() => null)) as { method?: string; params?: Record<string, unknown> } | null;
        if (body?.method === "tools/call") record(calls, body.params);
      }
      return handler.fetch(request);
    },
  });
  return {
    url: `http://localhost:${server.port}/mcp`,
    calls,
    close: () => server.stop(true),
  };
}
