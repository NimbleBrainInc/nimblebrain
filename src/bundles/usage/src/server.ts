/**
 * MCP server entry point for @nimblebraininc/usage bundle.
 *
 * Delegates to the shared usage aggregator which reads conversation files
 * directly. No indexes, no separate log files — conversations are the
 * source of truth.
 *
 * Uses stdio transport — stdout is JSON-RPC only, logging goes to stderr.
 *
 * In-monorepo constraint: this server imports its tool schemas from
 * `../../../tools/platform/schemas/usage.ts` so the standalone server
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
import { aggregateUsage } from "../../../conversation/usage-aggregator.ts";
import { UsageReportInput } from "../../../tools/platform/schemas/usage.ts";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WORK_DIR = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
const CONVERSATIONS_DIR = join(WORK_DIR, "conversations");

// UI: load the built React SPA from ui/dist/index.html
const UI_DIR = resolve(import.meta.dirname ?? __dirname, "../ui/dist");
const FALLBACK_HTML =
  "<html><body><p>UI not built. Run: cd src/bundles/usage/ui && bun install && bun run build</p></body></html>";

function loadUi(): string {
  const built = join(UI_DIR, "index.html");
  if (existsSync(built)) {
    return readFileSync(built, "utf-8");
  }
  return FALLBACK_HTML;
}

function log(msg: string): void {
  process.stderr.write(`[usage] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "report",
    description: "Get aggregated usage data (tokens, cost, tool calls) from conversation files.",
    inputSchema: UsageReportInput,
  },
];

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log(`Starting — conversations dir: ${CONVERSATIONS_DIR}`);

  const server = new Server(
    { name: "@nimblebraininc/usage", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name !== "report") {
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ error: `Unknown tool: ${name}` }) },
        ],
        isError: true,
      };
    }

    try {
      const period = (args?.period as string) ?? "month";
      const groupBy = (args?.groupBy as string) ?? "day";
      const from = args?.from as string | undefined;
      const to = args?.to as string | undefined;
      const result = await aggregateUsage(CONVERSATIONS_DIR, period, groupBy, { from, to });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Tool error (${name}): ${message}`);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri: "ui://usage/dashboard", name: "Usage Dashboard", mimeType: "text/html" }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "ui://usage/dashboard") {
      return {
        contents: [{ uri: request.params.uri, mimeType: "text/html", text: loadUi() }],
      };
    }
    throw new Error(`Resource not found: ${request.params.uri}`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Server connected via stdio");

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
