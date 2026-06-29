/**
 * Usage platform source — provides usage analytics via the `usage__report`
 * tool.
 *
 * Delegates to the shared usage aggregator which reads conversation files
 * directly. No indexes, no separate log files — conversations are the
 * source of truth.
 *
 * Post-Stage-1, conversations are user-owned and live top-level
 * (`{workDir}/conversations/{convId}.jsonl`), each carrying `ownerId` on
 * line 1. Usage is therefore inherently per-user. Two scopes:
 *
 *   - `scope: "user"` (default) — only the caller's own conversations,
 *     enforced by an `ownerFilter` in the aggregator (below this tool's
 *     surface, so a malformed call can't widen it).
 *   - `scope: "org"` — every user's conversations, attributed by owner.
 *     Gated to org admin/owner via `ORG_ADMIN_ROLES`, matching the
 *     `instructions__write_instructions` / `manage_users` precedent. Dev
 *     mode (no identity provider) bypasses the gate and the owner filter,
 *     so local development sees all conversations.
 */

import { listAllConversationFiles } from "../../conversation/locator.ts";
import { aggregateUsage } from "../../conversation/usage-aggregator.ts";
import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink, ToolResult } from "../../engine/types.ts";
import { ORG_ADMIN_ROLES } from "../../identity/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { loadUsageUi } from "../platform-resources/usage/dashboard.ts";
import { type UsageGroupBy, UsageReportInput, type UsageReportOutput } from "./schemas/usage.ts";

interface UsageReportArgs {
  scope?: "user" | "org";
  period?: string;
  groupBy?: UsageGroupBy | UsageGroupBy[];
  from?: string;
  to?: string;
}

const USAGE_REPORT_DESCRIPTION =
  "Get aggregated usage (tokens, cost, LLM calls) from conversation files. " +
  'Defaults to `scope: "user"` — only your own conversations. ' +
  '`scope: "org"` reports every user\'s usage and requires org admin/owner; ' +
  'pair it with `groupBy: "user"` for a per-user breakdown.';

/**
 * Resolve the owner filter and scope for a request, enforcing the org-admin
 * gate. Returns either an error result (denied) or the resolved
 * `{ scope, ownerFilter }`.
 *
 * - Dev mode (no identity provider): no gate, no filter — see all
 *   conversations regardless of requested scope. Matches the dev-mode
 *   posture in `instructions.ts::checkScopePermission`.
 * - `scope: "org"`: requires `ORG_ADMIN_ROLES`. No owner filter (all users).
 * - `scope: "user"` (default): filter to the caller's own id. An
 *   unauthenticated caller in a non-dev instance is denied (no id to scope
 *   to — fail closed rather than leak the whole org).
 */
function resolveScope(
  runtime: Runtime,
  requestedScope: "user" | "org",
): { scope: "user" | "org"; ownerFilter?: string } | { error: string } {
  // Dev mode — no identity provider configured. See everything.
  if (runtime.getIdentityProvider() === null) {
    return { scope: requestedScope, ownerFilter: undefined };
  }

  const identity = runtime.getCurrentIdentity();
  if (!identity) {
    return { error: "No authenticated identity." };
  }

  if (requestedScope === "org") {
    if (!ORG_ADMIN_ROLES.has(identity.orgRole)) {
      return { error: "Org-scope usage requires org admin or owner." };
    }
    return { scope: "org", ownerFilter: undefined };
  }

  // user scope — gate to the caller's own conversations.
  return { scope: "user", ownerFilter: identity.id };
}

export function createUsageSource(runtime: Runtime, eventSink: EventSink): McpSource {
  const tools: InProcessTool[] = [
    {
      name: "report",
      description: USAGE_REPORT_DESCRIPTION,
      inputSchema: UsageReportInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const args = input as UsageReportArgs;
          const requestedScope = args.scope ?? "user";

          const resolved = resolveScope(runtime, requestedScope);
          if ("error" in resolved) {
            return { content: textContent(resolved.error), isError: true };
          }

          const period = args.period ?? "month";
          const groupBy = args.groupBy ?? "day";

          // Conversations are workspace-owned; usage spans every workspace a user
          // touched, so aggregate over the conversation files across all workspaces.
          const files = listAllConversationFiles(runtime.getWorkspaceStore().getWorkspacesDir());
          const report = await aggregateUsage(files, period, groupBy, {
            from: args.from,
            to: args.to,
            ownerFilter: resolved.ownerFilter,
          });

          const out: UsageReportOutput = { scope: resolved.scope, ...report };
          return {
            content: textContent(JSON.stringify(out, null, 2)),
            // Wire-format cast: `structuredContent` is `Record<string,
            // unknown>`; the named `out` above is the load-bearing assertion.
            structuredContent: out as unknown as Record<string, unknown>,
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
