/**
 * Usage platform source — provides usage analytics via the nb__usage tool.
 *
 * Delegates to the shared usage aggregator which reads conversation files
 * directly. No indexes, no separate log files — conversations are the
 * source of truth.
 */

import { join } from "node:path";
import { aggregateUsage } from "../../conversation/usage-aggregator.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink } from "../../engine/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { loadUsageUi } from "../platform-resources/usage/dashboard.ts";
import { UsageReportInput } from "./schemas/usage.ts";

export function createUsageSource(runtime: Runtime, eventSink: EventSink): McpSource {
  const tools: InProcessTool[] = [
    {
      name: "report",
      description: "Get aggregated usage data (tokens, cost, tool calls) from structured logs.",
      inputSchema: UsageReportInput,
      handler: async (input: Record<string, unknown>) => {
        try {
          const wsDir = runtime.getWorkspaceScopedDir();
          const conversationsDir = join(wsDir, "conversations");
          const period = (input.period as string) ?? "month";
          const groupBy = (input.groupBy as string) ?? "day";
          const from = input.from as string | undefined;
          const to = input.to as string | undefined;
          const result = await aggregateUsage(conversationsDir, period, groupBy, from, to);
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
      },
    },
  ];

  const resources = new Map([
    ["ui://usage/dashboard", { text: loadUsageUi, mimeType: "text/html" }],
  ]);

  return defineInProcessApp(
    {
      name: "usage",
      version: "1.0.0",
      tools,
      resources,
    },
    eventSink,
  );
}
