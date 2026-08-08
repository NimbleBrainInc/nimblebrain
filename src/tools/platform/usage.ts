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
 *     admin/owner via `ORG_ADMIN_ROLES`, matching the
 *     `instructions__write_instructions` / `manage_users` precedent. Dev mode
 *     (no identity provider) bypasses the gate and the owner filter, so local
 *     development sees everything.
 */

import { textContent } from "../../engine/content-helpers.ts";
import type { EventSink, ToolResult } from "../../engine/types.ts";
import { ORG_ADMIN_ROLES } from "../../identity/types.ts";
import type { Runtime } from "../../runtime/runtime.ts";
import { aggregateUsage } from "../../usage/aggregate.ts";
import { defineInProcessApp, type InProcessTool } from "../in-process-app.ts";
import type { McpSource } from "../mcp-source.ts";
import { type UsageGroupBy, UsageReportInput, type UsageReportOutput } from "./schemas/usage.ts";

interface UsageReportArgs {
  scope?: "user" | "org";
  period?: string;
  groupBy?: UsageGroupBy | UsageGroupBy[];
  from?: string;
  to?: string;
}

const USAGE_REPORT_DESCRIPTION =
  "Get aggregated usage (tokens, cost, LLM calls) recorded at the point of spend. " +
  'Defaults to `scope: "user"` — only your own spend. ' +
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

          // The ledger is tenant-wide and workspace-agnostic: a line carries the
          // workspace it was bound to, so there is nothing to enumerate. The
          // owner filter below is what scopes the read, and it fails closed.
          const report = await aggregateUsage(runtime.getWorkDir(), period, groupBy, {
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
