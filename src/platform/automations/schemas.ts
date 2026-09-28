/**
 * Tool schema definitions for the automations source.
 *
 * The schemas themselves now live in `src/platform/schemas/automations.ts`
 * — that's the single source of truth shared between the standalone MCP
 * server (this app) and the in-process platform source. This file
 * re-exports them as the `TOOL_SCHEMAS` array consumed by both server
 * implementations.
 */

import {
  AutomationsCancelInput,
  AutomationsCreateInput,
  AutomationsDeleteInput,
  AutomationsListInput,
  AutomationsRunInput,
  AutomationsRunResultInput,
  AutomationsRunsInput,
  AutomationsStatusInput,
  AutomationsUpdateInput,
} from "../schemas/automations.ts";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "create",
    description:
      "Create a scheduled automation. `manifest` is the config; `body` is the prompt that " +
      "opens each run. Generates a kebab-case id from `manifest.name`. " +
      "Idempotent: returns the existing automation if one with the same id exists. " +
      "Scope: an automation belongs to the workspace it is created in, and runs as the creating " +
      "user. A run reaches only that workspace's tools and connectors (including personal " +
      "connectors granted to it) plus the owner's own tools, except those that create, change, " +
      "delete, or trigger automations — never another workspace's. So for an automation that " +
      "posts to a shared destination (e.g. Teams/Slack), create it in the workspace where that " +
      "connector is installed or granted. Runs stop while the owner is not a member of the " +
      "workspace.",
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
      "List automations with optional filters. Returns summary with human-readable schedule strings and relative times. Paged: returns at most 100 per call by default, with `total` reporting every match — follow `nextCursor` before concluding an automation is absent.",
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
    name: "run_result",
    description:
      "Fetch a single run's full result (the deliverable): the untruncated final output, " +
      "the activity log of every tool call, refs to any files the run wrote, and usage. " +
      "The run list (automations__runs / automations__status) carries only a truncated " +
      "preview — use this to read the whole result for one run by id.",
    inputSchema: AutomationsRunResultInput,
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
