/**
 * Tool schema definitions for the automations source.
 *
 * The schemas themselves now live in `src/tools/platform/schemas/automations.ts`
 * — that's the single source of truth shared between the standalone MCP
 * server (this bundle) and the in-process platform source. This file
 * re-exports them as the `TOOL_SCHEMAS` array consumed by both server
 * implementations.
 */

import {
  AutomationsCancelInput,
  AutomationsCreateInput,
  AutomationsDeleteInput,
  AutomationsListInput,
  AutomationsRunInput,
  AutomationsRunsInput,
  AutomationsStatusInput,
  AutomationsUpdateInput,
} from "../../../tools/platform/schemas/automations.ts";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "create",
    description:
      "Create a scheduled automation. `manifest` is the config; `body` is the prompt sent " +
      "to POST /v1/chat on each run. Generates a kebab-case id from `manifest.name`. " +
      "Idempotent: returns the existing automation if one with the same id exists. " +
      "Scope: automations are owned by the creating user and are NOT locked to one workspace — " +
      "a scheduled run executes as the owner and can use tools and connectors from any workspace " +
      "the owner is a member of (the workspace it was created in is just the default focus). " +
      "A connector is reachable only where it is installed AND the owner is a member; a connector " +
      "in another user's personal workspace is never reachable. So for an automation that posts to " +
      "a shared destination (e.g. Teams/Slack), the connector must live in a SHARED workspace the " +
      "owner belongs to — not a personal one. Do not tell users automations only see the tools of " +
      "the workspace they were created in.",
    inputSchema: AutomationsCreateInput,
  },
  {
    name: "update",
    description:
      "Update an existing automation by name. Provide a partial `manifest` patch and/or a new " +
      "`body` (prompt). Omitted fields keep their current values.",
    inputSchema: AutomationsUpdateInput,
  },
  {
    name: "delete",
    description: "Delete an automation by name. Removes the definition but preserves run history.",
    inputSchema: AutomationsDeleteInput,
  },
  {
    name: "list",
    description:
      "List automations with optional filters. Returns summary with human-readable schedule strings and relative times.",
    inputSchema: AutomationsListInput,
  },
  {
    name: "status",
    description: "Get full status of a single automation by name, including recent run history.",
    inputSchema: AutomationsStatusInput,
  },
  {
    name: "runs",
    description: "Query run history across automations with filters.",
    inputSchema: AutomationsRunsInput,
  },
  {
    name: "run",
    description:
      "Trigger an immediate execution of an automation, bypassing schedule and backoff. Returns the full run record when the run completes within ~30s; longer runs return {status: 'dispatched', automationId, message} and continue in the background — poll automations__runs to observe completion. Both shapes indicate the run was kicked off successfully; only an error response indicates failure to dispatch.",
    inputSchema: AutomationsRunInput,
  },
  {
    name: "cancel",
    description:
      "Cancel an in-flight automation run. Returns whether a run was actually cancelled.",
    inputSchema: AutomationsCancelInput,
  },
];
