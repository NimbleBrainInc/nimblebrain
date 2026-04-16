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
import type { Runtime } from "../../runtime/runtime.ts";
import type { InlineToolDef } from "../inline-source.ts";
import { InlineSource } from "../inline-source.ts";
import { USAGE_DASHBOARD_HTML } from "../platform-resources/usage/dashboard.ts";

export function createUsageSource(runtime: Runtime): InlineSource {
  const tools: InlineToolDef[] = [
    {
      name: "report",
      description: "Get aggregated usage data (tokens, cost, tool calls) from structured logs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          period: {
            type: "string",
            enum: ["day", "week", "month", "all"],
            description: "Time period. Default: month.",
          },
          from: {
            type: "string",
            description: "Start date (YYYY-MM-DD). Overrides period.",
          },
          to: {
            type: "string",
            description: "End date (YYYY-MM-DD). Default: today.",
          },
          groupBy: {
            type: "string",
            enum: ["day", "conversation", "model"],
            description: "Group breakdown. Default: day.",
          },
        },
      },
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

  const resources = new Map([["usage/dashboard", USAGE_DASHBOARD_HTML]]);

  return new InlineSource("usage", tools, { resources });
}
