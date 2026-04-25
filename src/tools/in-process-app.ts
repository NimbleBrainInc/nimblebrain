import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { PlacementDeclaration } from "../bundles/types.ts";
import type { EventSink, ToolResult } from "../engine/types.ts";
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
 */
export type InProcessResource =
  | string
  | {
      text?: string;
      blob?: Uint8Array;
      mimeType?: string;
      meta?: Record<string, unknown>;
    };

export interface DefineInProcessAppOptions {
  /** Source name. Becomes the `<source>__` tool prefix and the resource owner identity. */
  name: string;
  /** Server version reported in `initialize`. */
  version: string;
  tools: InProcessTool[];
  /**
   * Resources keyed by full URI (e.g. `ui://settings/panel`). Use full URIs
   * here even though pre-migration the InlineSource map dropped the scheme:
   * the MCP `readResource` request carries the full URI, so the server-side
   * key must match the protocol's identity.
   */
  resources?: Map<string, InProcessResource>;
  /** UI placements declared by this source. Surfaced via `McpSource.getPlacements()`. */
  placements?: PlacementDeclaration[];
  /** Optional `instructions` exposed via `initialize.instructions`. */
  instructions?: string;
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
  } = options;

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
              resources: resources.size > 0 ? {} : undefined,
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
        // Validation is preserved here (was previously enforced at the
        // InlineSource boundary) so missing/malformed input never reaches a
        // handler and surfaces a Node-internal error as a tool result.
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
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: `Unknown tool "${toolName}" in source "${name}". Available: ${available}`,
                  }),
                },
              ],
              isError: true,
            };
          }

          const input = (request.params.arguments ?? {}) as Record<string, unknown>;
          const validation = validateToolInput(input, tool.inputSchema);
          if (!validation.valid) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: `Invalid arguments for "${tool.name}": ${validation.error}`,
                  }),
                },
              ],
              isError: true,
            };
          }

          const result = await tool.handler(input);
          return {
            content: result.content,
            ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
            ...(result.isError ? { isError: true } : {}),
          };
        });

        if (resources.size > 0) {
          // resources/list — advertise URIs by full URI; name defaults to the
          // URI itself. Callers that care about display-friendly names can
          // pass them via the structured resource form in a future extension.
          server.setRequestHandler(ListResourcesRequestSchema, async () => ({
            resources: Array.from(resources.entries()).map(([uri, value]) => {
              const mimeType = typeof value === "string" ? "text/html" : value.mimeType;
              return {
                uri,
                name: uri,
                ...(mimeType ? { mimeType } : {}),
              };
            }),
          }));

          // resources/read — return one `contents[]` entry. Strings are HTML
          // by convention; structured entries pass through `_meta`. Missing
          // URIs raise `-32602` which the SDK transports as a JSON-RPC
          // error, matching how external MCP servers signal not-found.
          server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
            const uri = request.params.uri;
            const value = resources.get(uri);
            if (value === undefined) {
              throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`, { uri });
            }
            if (typeof value === "string") {
              return {
                contents: [{ uri, mimeType: "text/html", text: value }],
              };
            }
            const entry: Record<string, unknown> = { uri };
            if (value.mimeType) entry.mimeType = value.mimeType;
            if (value.blob) {
              // SDK schema accepts base64-encoded blob strings.
              entry.blob = bytesToBase64(value.blob);
            } else {
              entry.text = value.text ?? "";
            }
            if (value.meta) entry._meta = value.meta;
            return { contents: [entry] };
          });
        }

        const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        return { server, clientTransport };
      },
    },
    eventSink,
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Re-export of the plain `Transport` type so callers writing custom in-process
 * factories don't need to reach into the SDK.
 */
export type { Transport };
