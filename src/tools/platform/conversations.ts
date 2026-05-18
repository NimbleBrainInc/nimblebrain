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
import { loadConversationsUi } from "../platform-resources/conversations/browser.ts";
import {
  ConversationsExportInput,
  ConversationsForkInput,
  ConversationsGetInput,
  ConversationsListInput,
  ConversationsSearchInput,
  ConversationsStatsInput,
  ConversationsUpdateInput,
} from "./schemas/conversations.ts";

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
      inputSchema: ConversationsListInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleList(input as unknown as ListInput, index);
      }),
    },
    {
      name: "get",
      description:
        'Load a conversation by ID. Returns metadata plus, by default, the most recent ~20 messages (capped to a 50 KB response budget). Use expand:"metadata" for just the metadata or expand:"full" when you actually need the entire transcript — long conversations can run hundreds of thousands of tokens and full reads are recorded in tool history.',
      inputSchema: ConversationsGetInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleGet(input as unknown as GetInput, index);
      }),
    },
    {
      name: "search",
      description:
        "Full-text search across ALL message content in all conversations. Returns matching conversations with context snippets around each match.",
      inputSchema: ConversationsSearchInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleSearch(input as unknown as SearchInput, index);
      }),
    },
    {
      name: "update",
      description: "Update a conversation's title.",
      inputSchema: ConversationsUpdateInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleUpdate(input as unknown as UpdateInput, index);
      }),
    },
    {
      name: "fork",
      description:
        "Fork a conversation at a specific message index, creating a new conversation with messages up to that point.",
      inputSchema: ConversationsForkInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleFork(input as unknown as ForkInput, index);
      }),
    },
    {
      name: "stats",
      description:
        "Token usage analytics. Returns total tokens, breakdown by model and skill, and top tools used.",
      inputSchema: ConversationsStatsInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleStats(input as unknown as StatsInput, index);
      }),
    },
    {
      name: "export",
      description:
        "Export a conversation as markdown or JSON. Markdown renders messages as a readable document; JSON returns raw JSONL content as a JSON array.",
      inputSchema: ConversationsExportInput,
      handler: withErrorHandling(async (input) => {
        const { index } = await getIndex();
        return handleExport(input as unknown as ExportInput, index);
      }),
    },
  ];

  const resources = new Map([
    ["ui://conversations/browser", { text: loadConversationsUi, mimeType: "text/html" }],
  ]);

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
