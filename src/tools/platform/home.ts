import { join } from "node:path";
import { ActivityCollector } from "../../bundles/home/src/services/activity-collector.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink } from "../../engine/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { DASHBOARD_HTML } from "../platform-resources/home/dashboard.ts";

/**
 * Create the "home" platform source — an in-process MCP server.
 * Migrated from the former standalone MCP server at
 * src/bundles/home/src/server.ts.
 *
 * Tools: activity
 * Resources: ui://home/dashboard (React SPA)
 * Placements: sidebar home link at priority 0
 */
export function createHomeSource(runtime: Runtime, eventSink: EventSink): McpSource {
  const tools: InProcessTool[] = [
    {
      name: "activity",
      description:
        "Get raw workspace activity data — conversations, tool usage, bundle events, and errors. Use for specific questions about workspace activity.",
      inputSchema: {
        type: "object" as const,
        properties: {
          since: {
            type: "string",
            description: "ISO timestamp. Default: 24 hours ago.",
          },
          until: {
            type: "string",
            description: "ISO timestamp. Default: now.",
          },
          category: {
            type: "string",
            enum: ["conversations", "bundles", "tools", "errors"],
            description: "Filter to one category.",
          },
          limit: {
            type: "number",
            description: "Max items per category. Default: 50.",
          },
        },
      },
      handler: async (input: Record<string, unknown>) => {
        try {
          const wsDir = runtime.getWorkspaceScopedDir();
          const logDir = join(wsDir, "logs");
          const conversationsDir = join(wsDir, "conversations");
          const collector = new ActivityCollector(logDir, conversationsDir, wsDir);

          const defaults = {
            since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
            until: new Date().toISOString(),
            limit: 50,
          };

          const result = await collector.collect({
            since: (input.since as string | undefined) ?? defaults.since,
            until: (input.until as string | undefined) ?? defaults.until,
            category: input.category as
              | "conversations"
              | "bundles"
              | "tools"
              | "errors"
              | undefined,
            limit: (input.limit as number | undefined) ?? defaults.limit,
          });

          return {
            content: textContent(JSON.stringify(result)),
            isError: false,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: textContent(`Failed to get activity data: ${message}`),
            isError: true,
          };
        }
      },
    },
  ];

  const resources = new Map([["ui://home/dashboard", DASHBOARD_HTML]]);

  return defineInProcessApp(
    {
      name: "home",
      version: "1.0.0",
      tools,
      resources,
      placements: [
        {
          slot: "sidebar",
          resourceUri: "ui://home/dashboard",
          route: "/",
          label: "Home",
          icon: "house",
          priority: 0,
        },
      ],
    },
    eventSink,
  );
}
