import { join } from "node:path";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink } from "../../engine/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { ActivityCollector } from "../../services/activity-collector.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { loadHomeUi } from "../platform-resources/home/dashboard.ts";
import { HomeActivityInput } from "./schemas/home.ts";

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
      inputSchema: HomeActivityInput,
      handler: async (input: Record<string, unknown>) => {
        try {
          // Ownership-filter the activity view to the caller's
          // conversations. Stage 1's top-level store holds every
          // user's conversations in one directory; unfiltered the
          // dashboard would leak peer ids/titles/previews into User
          // A's view of their own activity.
          const identity = runtime.getCurrentIdentity();
          if (!identity) {
            return {
              content: textContent(
                JSON.stringify({ error: "home__activity requires an authenticated identity" }),
              ),
              isError: true,
            };
          }
          const wsDir = runtime.getWorkspaceScopedDir();
          const logDir = join(wsDir, "logs");
          const automationRunsDir = join(wsDir, "automations", "runs");
          const collector = new ActivityCollector({
            logDir,
            conversations: {
              kind: "store",
              store: { list: (o, a) => runtime.listConversations(o, a) },
            },
            automationRunsDir,
            access: { userId: identity.id },
          });

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

  const resources = new Map([["ui://home/dashboard", { text: loadHomeUi, mimeType: "text/html" }]]);

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
