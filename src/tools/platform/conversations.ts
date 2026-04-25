import { join } from "node:path";
import { ConversationIndex } from "../../bundles/conversations/src/index-cache.ts";
import { type ExportInput, handleExport } from "../../bundles/conversations/src/tools/export.ts";
import { type ForkInput, handleFork } from "../../bundles/conversations/src/tools/fork.ts";
import { type GetInput, handleGet } from "../../bundles/conversations/src/tools/get.ts";
import { handleList, type ListInput } from "../../bundles/conversations/src/tools/list.ts";
import { handleSearch, type SearchInput } from "../../bundles/conversations/src/tools/search.ts";
import { handleStats, type StatsInput } from "../../bundles/conversations/src/tools/stats.ts";
import { handleUpdate, type UpdateInput } from "../../bundles/conversations/src/tools/update.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink } from "../../engine/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { BROWSER_HTML } from "../platform-resources/conversations/browser.ts";

/**
 * Create the "conversations" platform source — an in-process MCP server.
 * Migrated from the former standalone MCP server at
 * src/bundles/conversations/src/server.ts.
 *
 * Tools: list, get, search, update, fork, stats, export
 * Resources: ui://conversations/browser (HTML SPA)
 * Placements: sidebar conversations link at priority 1
 */
export async function createConversationsSource(
  runtime: Runtime,
  eventSink: EventSink,
): Promise<McpSource> {
  // Per-workspace ConversationIndex cache — lazy-built on first access.
  // Each workspace gets its own index pointing at its own conversations directory.
  const indexCache = new Map<string, ConversationIndex>();

  async function getIndex(): Promise<{ index: ConversationIndex; dir: string }> {
    const wsDir = runtime.getWorkspaceScopedDir();
    const dir = join(wsDir, "conversations");
    const cacheKey = dir; // unique per workspace path

    let index = indexCache.get(cacheKey);
    if (!index) {
      index = new ConversationIndex();
      await index.build(dir);
      index.startWatching(dir);
      indexCache.set(cacheKey, index);
    }
    return { index, dir };
  }

  /** Shared error handler — catches, formats, returns isError result. */
  function withErrorHandling(
    fn: (input: Record<string, unknown>) => Promise<object>,
  ): (
    input: Record<string, unknown>,
  ) => Promise<{ content: ReturnType<typeof textContent>; isError: boolean }> {
    return async (input) => {
      try {
        const result = await fn(input);
        return {
          content: textContent(JSON.stringify(result, null, 2)),
          isError: false,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: textContent(JSON.stringify({ error: message })),
          isError: true,
        };
      }
    };
  }

  const tools: InProcessTool[] = [
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
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleList(input as unknown as ListInput, index);
      }),
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
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleGet(input as unknown as GetInput, index);
      }),
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
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleSearch(input as unknown as SearchInput, index);
      }),
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
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleUpdate(input as unknown as UpdateInput, index);
      }),
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
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleFork(input as unknown as ForkInput, index);
      }),
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
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleStats(input as unknown as StatsInput, index);
      }),
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
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleExport(input as unknown as ExportInput, index);
      }),
    },
  ];

  const resources = new Map([["ui://conversations/browser", BROWSER_HTML]]);

  return defineInProcessApp(
    {
      name: "conversations",
      version: "1.0.0",
      tools,
      resources,
      placements: [
        {
          slot: "sidebar",
          resourceUri: "ui://conversations/browser",
          route: "@nimblebraininc/conversations",
          label: "Conversations",
          icon: "message-square-text",
          priority: 1,
        },
      ],
    },
    eventSink,
  );
}
