/**
 * MCP server entry point for @nimblebraininc/conversations bundle.
 *
 * Reads JSONL conversation files from NB_CONVERSATIONS_DIR (default: ~/.nimblebrain/conversations/).
 * Exposes 7 v0.1 tools: list, get, search, update, fork, stats, export.
 * Uses stdio transport — stdout is JSON-RPC only, logging goes to stderr.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ConversationIndex } from "./index-cache.ts";
import { type ExportInput, handleExport } from "./tools/export.ts";
import { type ForkInput, handleFork } from "./tools/fork.ts";
import { type GetInput, handleGet } from "./tools/get.ts";
import { handleList, type ListInput } from "./tools/list.ts";
import { handleSearch, type SearchInput } from "./tools/search.ts";
import { handleStats, type StatsInput } from "./tools/stats.ts";
import { handleUpdate, type UpdateInput } from "./tools/update.ts";
import { BROWSER_HTML } from "./ui/browser.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORK_DIR = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
const CONVERSATIONS_DIR = join(WORK_DIR, "conversations");

function log(msg: string): void {
  process.stderr.write(`[conversations] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema matching spec §8.1)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list",
    description:
      "List conversations with pagination, sorting, and filtering. Returns conversation metadata (title, timestamps, token counts, preview).",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max conversations to return. Default: 20.",
        },
        cursor: {
          type: "string",
          description: "Opaque pagination cursor from a previous response.",
        },
        search: {
          type: "string",
          description: "Substring match on title and preview.",
        },
        sortBy: {
          type: "string",
          enum: ["created", "updated"],
          description: 'Sort field. Default: "updated".',
        },
        dateFrom: {
          type: "string",
          description: "Filter: only conversations created on or after this ISO 8601 date.",
        },
        dateTo: {
          type: "string",
          description: "Filter: only conversations created on or before this ISO 8601 date.",
        },
      },
    },
  },
  {
    name: "get",
    description:
      "Load a conversation's full message history including metadata, message content, tool calls, and token usage per message.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Conversation ID.",
        },
        limit: {
          type: "number",
          description: "Max messages to return (from end of conversation).",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "search",
    description:
      "Full-text search across ALL message content in all conversations. Returns matching conversations with context snippets around each match.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query. Case-insensitive substring match on message content.",
        },
        limit: {
          type: "number",
          description: "Max conversations to return. Default: 10.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "update",
    description: "Update a conversation's title.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Conversation ID.",
        },
        title: {
          type: "string",
          description: "New title for the conversation.",
        },
      },
      required: ["id", "title"],
    },
  },
  {
    name: "fork",
    description:
      "Fork a conversation at a specific message index, creating a new conversation with messages up to that point.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Source conversation ID.",
        },
        atMessage: {
          type: "number",
          description: "Message index to fork at. Default: all messages.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "stats",
    description:
      "Token usage analytics. Returns total tokens, breakdown by model and skill, and top tools used.",
    inputSchema: {
      type: "object" as const,
      properties: {
        period: {
          type: "string",
          enum: ["day", "week", "month", "all"],
          description: 'Time period for stats. Default: "week".',
        },
      },
    },
  },
  {
    name: "export",
    description:
      "Export a conversation as markdown or JSON. Markdown renders messages as a readable document; JSON returns raw JSONL content as a JSON array.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "Conversation ID.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "Export format.",
        },
      },
      required: ["id", "format"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool routing
// ---------------------------------------------------------------------------

type ToolArgs = Record<string, unknown>;

async function routeToolCall(
  name: string,
  args: ToolArgs,
  index: ConversationIndex,
): Promise<object> {
  switch (name) {
    case "list":
      return handleList(args as unknown as ListInput, index);
    case "get":
      return handleGet(args as unknown as GetInput, index);
    case "search":
      return handleSearch(args as unknown as SearchInput, index);
    case "update":
      return handleUpdate(args as unknown as UpdateInput, index);
    case "fork":
      return handleFork(args as unknown as ForkInput, index);
    case "stats":
      return handleStats(args as unknown as StatsInput, index);
    case "export":
      return handleExport(args as unknown as ExportInput, index);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Starting with conversations dir: ${CONVERSATIONS_DIR}`);

  // Build the in-memory index from JSONL file headers
  const index = new ConversationIndex();
  await index.build(CONVERSATIONS_DIR);
  log(`Indexed ${index.size} conversations`);

  // Start watching for file changes
  index.startWatching(CONVERSATIONS_DIR);

  // Create MCP server
  const server = new Server(
    {
      name: "@nimblebraininc/conversations",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    },
  );

  // Register tool listing handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  // Register tool call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await routeToolCall(name, args ?? {}, index);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Tool error (${name}): ${message}`);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  });

  // Register resource listing handler
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "ui://conversations/browser",
        name: "Conversation Browser",
        mimeType: "text/html",
      },
    ],
  }));

  // Register resource read handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "ui://conversations/browser") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/html",
            text: BROWSER_HTML,
          },
        ],
      };
    }
    throw new Error(`Resource not found: ${request.params.uri}`);
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("Server connected via stdio");

  // Clean shutdown
  const shutdown = async () => {
    log("Shutting down...");
    index.stopWatching();
    await server.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
