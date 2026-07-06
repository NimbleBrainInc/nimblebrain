import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { PlacementDeclaration } from "../bundles/types.ts";
import type { EventSink, ToolResult } from "../engine/types.ts";
import { bytesToBase64 } from "../util/base64.ts";
import { coerceInputForSchema } from "./coerce-input.ts";
import { McpSource } from "./mcp-source.ts";
import { validateToolInput } from "./validate-input.ts";

/**
 * Tool definition for an in-process MCP server. Mirrors the shape the
 * platform sources used pre-migration so authoring stays a function and a
 * JSON schema — no Zod adapter, no SDK boilerplate per tool.
 *
 * `annotations` is sent on the wire as the tool's `_meta` (free-form per
 * MCP). `McpSource.tools()` reads `_meta` back as `annotations` on the
 * client side, preserving round-trip semantics — including platform
 * conventions like `"ai.nimblebrain/internal": true` to hide a tool from
 * the agent's tool list.
 */
export interface InProcessTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<ToolResult>;
  annotations?: Record<string, unknown>;
}

/**
 * Resource entry for an in-process app. Strings are treated as HTML
 * (`mimeType: "text/html"`) — the common case for `ui://` panels.
 * Pass the structured form for non-HTML text, binary blobs, or to attach
 * `_meta` (e.g. ext-apps `io.modelcontextprotocol/ui` CSP / permissions).
 *
 * The `text` field accepts a string OR an async function. The function form
 * is invoked on every `resources/read` so the body can be assembled lazily
 * (e.g. composed prompts that change per assembly).
 */
export type InProcessResource =
  | string
  | {
      text?: string | (() => Promise<string>);
      blob?: Uint8Array;
      mimeType?: string;
      meta?: Record<string, unknown>;
    };

/**
 * Resource template advertisement — RFC 6570 URI templates surfaced via
 * `resources/templates/list`. A template tells clients "URIs of this shape
 * are readable" without enumerating each one. Reads dispatch through
 * `resourceHandler` (or the static map for materialized URIs).
 */
export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * Dynamic resource entry surfaced from `listResources()`. Same wire shape as
 * static map entries — `uri` is required; `name` defaults to the URI when
 * absent, matching how the static map is rendered.
 */
export interface DynamicResourceEntry {
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface DefineInProcessAppOptions {
  /** Source name. Becomes the `<source>__` tool prefix and the resource owner identity. */
  name: string;
  /** Server version reported in `initialize`. */
  version: string;
  tools: InProcessTool[];
  /**
   * Resources keyed by full URI (e.g. `ui://settings/panel`). Required to
   * match the protocol identity — the MCP `readResource` request carries
   * the full URI, so the server-side lookup key must match exactly.
   */
  resources?: Map<string, InProcessResource>;
  /** UI placements declared by this source. Surfaced via `McpSource.getPlacements()`. */
  placements?: PlacementDeclaration[];
  /** Optional `instructions` exposed via `initialize.instructions`. */
  instructions?: string;
  /**
   * URI templates advertised via `resources/templates/list`. Use for
   * parametric URIs (e.g. `instructions://bundles/{name}`) where the catalog
   * is dynamic but the shape is known.
   */
  templates?: ResourceTemplate[];
  /**
   * Async dynamic supplement to the static `resources` map. Entries are
   * merged into `resources/list` after the static entries on every call.
   * Use when the catalog depends on workspace state (e.g. installed bundles).
   */
  listResources?: () => Promise<DynamicResourceEntry[]>;
  /**
   * Async fallback for `resources/read` when the static map misses. Returns
   * the resolved resource or `null` to signal not-found (which surfaces as
   * `McpError(InvalidParams)` to the client).
   */
  resourceHandler?: (uri: string) => Promise<InProcessResource | null>;
}

/**
 * Build an `McpSource` backed by an in-process MCP `Server` over an
 * `InMemoryTransport`. Conceptually: the source becomes a real MCP server
 * that just happens to live in this process. Every MCP capability the SDK
 * implements (resources, tools, instructions, tasks, prompts, sampling…)
 * works for it for free, byte-identical to what subprocess and remote
 * sources get.
 *
 * The factory closure is invoked on every `start()`/`restart()`. Each call
 * produces a fresh Server and a fresh `InMemoryTransport` linked pair —
 * `InMemoryTransport` is single-use after close, and `Server.connect()`
 * claims one transport instance permanently. McpSource owns the Server
 * for its lifetime and closes it explicitly on `stop()`.
 */
export function defineInProcessApp(
  options: DefineInProcessAppOptions,
  eventSink: EventSink,
): McpSource {
  const {
    name,
    version,
    tools,
    resources = new Map<string, InProcessResource>(),
    placements = [],
    instructions,
    templates,
    listResources,
    resourceHandler,
  } = options;

  // Any of the four fields means this source serves resources. When ANY is
  // active, advertise `listChanged` + `subscribe` so external clients (and
  // the SDK) know they can watch for changes — even if the dynamic catalog
  // is empty at this instant. Sources with no resource fields keep
  // `resources: undefined` to stay invisible to `resources/*` requests.
  const hasResources =
    resources.size > 0 ||
    (templates !== undefined && templates.length > 0) ||
    listResources !== undefined ||
    resourceHandler !== undefined;
  const hasTemplates = templates !== undefined && templates.length > 0;

  return new McpSource(
    name,
    {
      type: "inProcess",
      placements,
      createServer: async () => {
        const server = new Server(
          { name, version },
          {
            capabilities: {
              tools: {},
              resources: hasResources ? { listChanged: true, subscribe: true } : undefined,
            },
            ...(instructions ? { instructions } : {}),
          },
        );

        // tools/list — translate InProcessTool[] into the MCP wire shape.
        // Annotations ride on `_meta` (free-form by spec) so they survive
        // round-trip and reach `McpSource.tools()` as `annotations`.
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema as {
              type: "object";
              properties?: Record<string, unknown>;
              required?: string[];
            },
            ...(t.annotations ? { _meta: t.annotations } : {}),
          })),
        }));

        // tools/call — JSON-Schema validate, then dispatch to the handler.
        // Validation runs at this boundary so missing/malformed input never
        // reaches a handler and surfaces a Node-internal error as a tool
        // result.
        //
        // Unknown-tool errors are returned as a structured `isError: true`
        // result rather than thrown as `MethodNotFound`. Throwing would
        // surface to `McpSource.execute()` as a transport-level failure and
        // trigger the source's crash-restart path — for an in-process
        // server, that's a server rebuild for every typo. The agent loop
        // already handles `isError: true` cleanly.
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const toolName = request.params.name;
          const tool = tools.find((t) => t.name === toolName);
          if (!tool) {
            const available = tools.map((t) => t.name).join(", ");
            return errorResult(
              `Unknown tool "${toolName}" in source "${name}". Available: ${available}`,
            );
          }

          // Coerce nested string-encoded object/array values before
          // validating — see src/tools/coerce-input.ts for rationale. The
          // engine performs the same step, but external `/mcp` clients
          // bypass the engine and enter directly here.
          const rawInput = (request.params.arguments ?? {}) as Record<string, unknown>;
          const input = coerceInputForSchema(rawInput, tool.inputSchema);
          const validation = validateToolInput(input, tool.inputSchema);
          if (!validation.valid) {
            return errorResult(`Invalid arguments for "${tool.name}": ${validation.error}`);
          }

          const result = await tool.handler(input);
          return toInProcessCallResult(result);
        });

        if (hasResources) {
          // resources/list — advertise URIs by full URI; name defaults to the
          // URI itself. Static map entries are listed first; dynamic entries
          // from `listResources()` are appended on every call so the catalog
          // can react to workspace state without restarting the server.
          server.setRequestHandler(ListResourcesRequestSchema, async () => {
            const staticEntries = Array.from(resources.entries()).map(([uri, value]) => {
              const mimeType = typeof value === "string" ? "text/html" : value.mimeType;
              return {
                uri,
                name: uri,
                ...(mimeType ? { mimeType } : {}),
              };
            });
            const dynamicEntries = listResources
              ? (await listResources()).map((entry) => ({
                  uri: entry.uri,
                  name: entry.name ?? entry.uri,
                  ...(entry.mimeType ? { mimeType: entry.mimeType } : {}),
                }))
              : [];
            return { resources: [...staticEntries, ...dynamicEntries] };
          });

          // resources/read — resolve the URI, then shape one `contents[]`
          // entry. A missing URI raises `-32602`, which the SDK transports as a
          // JSON-RPC error, matching how external MCP servers signal not-found.
          server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const uri = request.params.uri;
            const value = await resolveResourceValue(uri, resources, resourceHandler);
            if (value === undefined) {
              throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`, { uri });
            }
            return { contents: [await buildResourceContents(uri, value)] };
          });

          // resources/templates/list — only registered when templates are
          // declared. SDK rejects the request with MethodNotFound otherwise,
          // matching how a server that doesn't advertise templates behaves.
          if (hasTemplates) {
            server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
              resourceTemplates: templates.map((t) => ({
                uriTemplate: t.uriTemplate,
                name: t.name,
                ...(t.description ? { description: t.description } : {}),
                ...(t.mimeType ? { mimeType: t.mimeType } : {}),
              })),
            }));
          }
        }

        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        return { server, clientTransport };
      },
    },
    eventSink,
  );
}

// ── tools/call + resources/read shaping helpers ────────────────────────────

/** Build an `isError: true` tool result carrying a JSON `{ error }` payload. */
function errorResult(error: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
    isError: true,
  };
}

/**
 * Shape an engine `ToolResult` into the MCP `tools/call` wire result.
 *
 * Forwards result `_meta` onto the wire so it round-trips back to the caller as
 * `ToolResult._meta` (e.g. the supervisor's non-advancing hint).
 * `CallToolResult._meta` is a loose object, so arbitrary reverse-DNS keys
 * survive the round-trip.
 */
function toInProcessCallResult(result: ToolResult) {
  return {
    content: result.content,
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError ? { isError: true } : {}),
    ...(result._meta ? { _meta: result._meta } : {}),
  };
}

/**
 * Resolve a resource URI to its value: the static map first, then the async
 * `resourceHandler` fallback. The handler returning `null` is treated as
 * not-found — same as a missing static entry, both surfacing here as `undefined`.
 */
async function resolveResourceValue(
  uri: string,
  resources: Map<string, InProcessResource>,
  resourceHandler: ((uri: string) => Promise<InProcessResource | null>) | undefined,
): Promise<InProcessResource | undefined> {
  const value = resources.get(uri);
  if (value !== undefined) return value;
  if (resourceHandler) {
    const resolved = await resourceHandler(uri);
    if (resolved !== null) return resolved;
  }
  return undefined;
}

/**
 * Shape one resolved resource into an MCP `contents[]` entry. Strings are HTML
 * by convention; structured entries pass through `_meta`. Function-form `text`
 * is awaited here so the body can be assembled lazily on each read.
 */
async function buildResourceContents(
  uri: string,
  value: InProcessResource,
): Promise<Record<string, unknown>> {
  if (typeof value === "string") {
    return { uri, mimeType: "text/html", text: value };
  }
  const entry: Record<string, unknown> = { uri };
  if (value.mimeType) entry.mimeType = value.mimeType;
  if (value.blob) {
    // SDK schema accepts base64-encoded blob strings.
    entry.blob = bytesToBase64(value.blob);
  } else {
    const text = value.text;
    entry.text = typeof text === "function" ? await text() : (text ?? "");
  }
  if (value.meta) entry._meta = value.meta;
  return entry;
}

/**
 * Re-export of the plain `Transport` type so callers writing custom in-process
 * factories don't need to reach into the SDK.
 */
export type { Transport };
