/**
 * Usage platform source — provides usage analytics via the `usage__report`
 * tool.
 *
 * Delegates to the shared aggregator, which reads the durable ledger under
 * `{workDir}/usage/` — the sole source for tenant-level spend. Nothing here
 * scans storage: a line carries the identity, workspace and session it was
 * spent under, so attribution is a field on the record rather than something
 * derived from where a file happens to sit.
 *
 * Two scopes:
 *
 *   - `scope: "user"` (default) — only the caller's own spend, enforced by an
 *     `ownerFilter` in the aggregator (below this tool's surface, so a
 *     malformed call can't widen it) that fails closed on a line with no
 *     `userId`.
 *   - `scope: "org"` — every user's spend, attributed by owner. Gated to org
 *     admin via `ORG_ADMIN_ROLES`, matching the
 *     `instructions__write_instructions` / `manage_users` precedent.
 */

import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink, ToolResult } from "../../engine/types.ts";
import { ORG_ADMIN_ROLES } from "../../identity/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { defineInProcessApp, type InProcessTool } from "../../tools/in-process-app.ts";
import type { McpSource } from "../../tools/mcp-source.ts";
import { WORKSPACE_OPTIONAL_META } from "../../tools/workspace-optional.ts";
import { aggregateUsage } from "../../usage/aggregate.ts";
import {
  type UsageGroupBy,
  type UsageOrigin,
  UsageReportInput,
  type UsageReportOutput,
  type UsageStackBy,
} from "../schemas/usage.ts";

interface UsageReportArgs {
  scope?: "user" | "org";
  period?: string;
  groupBy?: UsageGroupBy | UsageGroupBy[];
  from?: string;
  to?: string;
  stackBy?: UsageStackBy;
  workspaceId?: string;
  userId?: string;
  model?: string;
  origin?: UsageOrigin;
}

const USAGE_REPORT_DESCRIPTION =
  "Get aggregated usage (tokens, cost, LLM calls) recorded at the point of spend. " +
  'Defaults to `scope: "user"` — only your own spend. ' +
  '`scope: "org"` reports every user\'s usage and requires org admin; ' +
  'pair it with `groupBy: "user"` for a per-user breakdown. ' +
  "`workspaceId`, `userId`, `model`, and `origin` narrow the calls counted.";

/**
 * Resolve the owner filter and scope for a request, enforcing the org-admin
 * gate. Returns either an error result (denied) or the resolved
 * `{ scope, ownerFilter }`.
 *
 * - `scope: "org"`: requires `ORG_ADMIN_ROLES`. No owner filter (all users).
 * - `scope: "user"` (default): filter to the caller's own id. An
 *   unauthenticated caller is denied (no id to scope
 *   to — fail closed rather than leak the whole org).
 */
function resolveScope(
  runtime: Runtime,
  requestedScope: "user" | "org",
): { scope: "user" | "org"; ownerFilter?: string } | { error: string } {
  const identity = runtime.getCurrentIdentity();
  if (!identity) {
    return { error: "No authenticated identity." };
  }

  if (requestedScope === "org") {
    if (!ORG_ADMIN_ROLES.has(identity.orgRole)) {
      return { error: "Org-scope usage requires org admin." };
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
      meta: { ...WORKSPACE_OPTIONAL_META },
      inputSchema: UsageReportInput,
      handler: async (input: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const args = input as UsageReportArgs;
          const requestedScope = args.scope ?? "user";

          const resolved = resolveScope(runtime, requestedScope);
          if ("error" in resolved) {
            return { content: textContent(resolved.error), isError: true };
          }
          // A user-scope caller may name only themselves. Refused rather than
          // returned empty, so asking for a peer's spend reads as not allowed
          // instead of as "they spent nothing". The aggregator ANDs this with
          // `ownerFilter` regardless, so it could not widen the read anyway.
          if (
            resolved.ownerFilter !== undefined &&
            args.userId !== undefined &&
            args.userId !== resolved.ownerFilter
          ) {
            return {
              content: textContent('Filtering by another user requires scope: "org".'),
              isError: true,
            };
          }

          const period = args.period ?? "month";
          const groupBy = args.groupBy ?? "day";

          // The ledger is tenant-wide and workspace-agnostic: a line carries the
          // workspace it was bound to, so there is nothing to enumerate. The
          // owner filter below is what scopes the read, and it fails closed.
          const report = await aggregateUsage(runtime.getWorkDir(), period, groupBy, {
            from: args.from,
            to: args.to,
            ownerFilter: resolved.ownerFilter,
            stackBy: args.stackBy,
            filters: {
              workspaceId: args.workspaceId,
              userId: args.userId,
              model: args.model,
              origin: args.origin,
            },
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

  // No UI resource. Usage has one rendering, the `/org/usage` settings page,
  // for the same reason it has one reader: a second surface over the same
  // numbers has nothing keeping it in step, and the two deleted here proved it
  // — neither carried the unpriced caveat or the sessions split the page
  // gained, and nothing failed when they fell behind. See the ledger's
  // one-reader merge bar.
  return defineInProcessApp(
    {
      name: "usage",
      version: "1.0.0",
      tools,
    },
    eventSink,
  );
}
