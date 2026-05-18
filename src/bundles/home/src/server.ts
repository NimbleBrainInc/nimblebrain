/**
 * MCP server entry point for @nimblebraininc/home bundle.
 *
 * Reads workspace data from NB_WORK_DIR (default: ~/.nimblebrain).
 * Exposes 1 tool: activity. Briefing generation moved to nb__briefing.
 * Uses stdio transport — stdout is JSON-RPC only, logging goes to stderr.
 *
 * In-monorepo constraint: this server imports its tool schemas from
 * `../../../tools/platform/schemas/home.ts` so the standalone server
 * and the in-process platform source share one source of truth. The
 * cross-tree import means this directory cannot be packaged as a
 * standalone .mcpb without first inlining or vendoring the schema file.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { ActivityCollector } from "../../../services/activity-collector.ts";
import { HomeActivityInput } from "../../../tools/platform/schemas/home.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORK_DIR = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
const LOG_DIR = join(WORK_DIR, "logs");
const CONVERSATIONS_DIR = join(WORK_DIR, "conversations");

// UI: load the built React SPA from ui/dist/index.html
const UI_DIR = resolve(import.meta.dirname ?? __dirname, "../ui/dist");
const FALLBACK_HTML =
  "<html><body><p>UI not built. Run: cd src/bundles/home/ui && bun install && bun run build</p></body></html>";

function loadUi(): string {
  const built = join(UI_DIR, "index.html");
  if (existsSync(built)) {
    return readFileSync(built, "utf-8");
  }
  return FALLBACK_HTML;
}

function log(msg: string): void {
  process.stderr.write(`[home] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema matching spec)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "activity",
    description:
      "Get raw workspace activity data — conversations, tool usage, bundle events, and errors. Use for specific questions about workspace activity.",
    inputSchema: HomeActivityInput,
  },
];

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Starting with work dir: ${WORK_DIR}`);

  // Create service instances (briefing generation moved to nb__briefing)
  const collector = new ActivityCollector({
    logDir: LOG_DIR,
    conversations: { kind: "jsonl", conversationsDir: CONVERSATIONS_DIR },
    automationRunsDir: join(WORK_DIR, "automations", "runs"),
  });

  // Create MCP server
  const server = new Server(
    {
      name: "@nimblebraininc/home",
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
      let result: unknown;

      switch (name) {
        case "activity": {
          const defaults = {
            since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            until: new Date().toISOString(),
            limit: 50,
          };
          result = await collector.collect({
            ...defaults,
            since: (args?.since as string | undefined) ?? defaults.since,
            until: (args?.until as string | undefined) ?? defaults.until,
            category: args?.category as
              | "conversations"
              | "bundles"
              | "tools"
              | "errors"
              | undefined,
            limit: (args?.limit as number | undefined) ?? defaults.limit,
          });
          break;
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
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
            text: `Failed to get activity data: ${message}`,
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
        uri: "ui://home/dashboard",
        name: "Home Dashboard",
        mimeType: "text/html",
      },
    ],
  }));

  // Register resource read handler
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "ui://home/dashboard") {
      return {
        contents: [
          {
            uri: request.params.uri,
            mimeType: "text/html",
            text: loadUi(),
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
