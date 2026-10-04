/**
 * Tool schema definitions for the tasks source.
 *
 * The schemas themselves now live in `src/platform/schemas/tasks.ts`
 * — that's the single source of truth shared between the standalone MCP
 * server (this app) and the in-process platform source. This file
 * re-exports them as the `TOOL_SCHEMAS` array consumed by both server
 * implementations.
 */

import {
  TasksAssessInput,
  TasksBatchControlInput,
  TasksBatchesInput,
  TasksBatchInput,
  TasksCancelInput,
  TasksCreateInput,
  TasksDeleteInput,
  TasksListInput,
  TasksRunBatchInput,
  TasksRunInput,
  TasksRunResultInput,
  TasksRunsInput,
  TasksStatusInput,
  TasksUpdateInput,
} from "../schemas/tasks.ts";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "create",
    description:
      "Create a task. `manifest` is the config; `body` is the prompt that " +
      "opens each run. Generates a kebab-case id from `manifest.name`. Its schedule recurs " +
      "(cron, interval), fires once at a set time (once), fires on routed notifications " +
      "(event), or is omitted for a task that runs only when someone runs it. " +
      "Idempotent: returns the existing task if one with the same id exists. " +
      "Scope: a task belongs to the workspace it is created in, and runs as the creating " +
      "user. A run reaches only that workspace's tools and connectors (including personal " +
      "connectors granted to it) plus the owner's own tools, except those that create, change, " +
      "delete, or trigger tasks — never another workspace's. So for a task that " +
      "posts to a shared destination (e.g. Teams/Slack), create it in the workspace where that " +
      "connector is installed or granted. Runs stop while the owner is not a member of the " +
      "workspace.",
    inputSchema: TasksCreateInput,
  },
  {
    name: "update",
    description:
      "Update an existing task by name. Provide a partial `manifest` patch and/or a new " +
      "`body` (prompt). Omitted fields keep their current values.",
    inputSchema: TasksUpdateInput,
  },
  {
    name: "delete",
    description: "Delete a task by name. Removes the definition but preserves run history.",
    inputSchema: TasksDeleteInput,
  },
  {
    name: "list",
    description:
      "List tasks with optional filters. Returns summary with human-readable schedule strings and relative times. Paged: returns at most 100 per call by default, with `total` reporting every match — follow `nextCursor` before concluding a task is absent.",
    inputSchema: TasksListInput,
  },
  {
    name: "status",
    description: "Get full status of a single task by name, including recent run history.",
    inputSchema: TasksStatusInput,
  },
  {
    name: "runs",
    description:
      "Query run history across tasks with filters. Each run carries its `execution` (how it " +
      "ended), its `assessment` when judged, and the `label` it reads as (Succeeded, Poor " +
      "result, Needs review, Failed, ...). History is kept indefinitely: for " +
      "one task, pass the response's `nextBefore` back as `before` to page further back.",
    inputSchema: TasksRunsInput,
  },
  {
    name: "run_result",
    description:
      "Fetch a single run's full result (the deliverable): the untruncated final output, " +
      "the activity log of every tool call, refs to any files the run wrote, usage, and the " +
      "parsed `structured` output when the task has an outputSchema. The run list " +
      "(tasks__runs / tasks__status) carries only a truncated preview — use this " +
      "to read the whole result for one run by id. A run tasks__run started is found by " +
      "its `runId` alone.",
    inputSchema: TasksRunResultInput,
  },
  {
    name: "run",
    description:
      "Run a task now, bypassing schedule and backoff: a saved one by `name`, or an " +
      "inline one-off from `prompt` (or `skill`) plus optional schemas, criteria, tools, " +
      "limits, and budget, which creates a `oneoff` task with no schedule and runs it once. `input` " +
      "is JSON for the run, checked against the task's inputSchema and given to the run " +
      "as data. `idempotencyKey` makes the call safe to repeat: a repeat returns the run the " +
      "first call started. Runs a disabled task too (enabled: false): Run now is a " +
      "deliberate act, while a disabled task is never fired by its schedule or by events. " +
      "The response carries `enabled` and says when it is false. Returns the full run record " +
      "when the run completes within ~30s. A longer run returns {status: 'dispatched', " +
      "taskId, runId, startedAt, enabled, message}: it is still running in the " +
      "background, not failed and not ignored; read it with tasks__run_result (runId) " +
      "when it ends, or stop it with tasks__cancel. Only an error response means the run " +
      "did not start.",
    inputSchema: TasksRunInput,
  },
  {
    name: "assess",
    description:
      "Set your verdict on a run's deliverable ({runId, verdict: 'pass'|'fail', note?}), or " +
      "judge it again with the task's current schema and criteria ({runId, reassess: true}). " +
      "Your verdict is recorded beside the judge's and replaces it in how the run reads " +
      "(its `label`). Only a run that left a deliverable has an assessment. A run is found by " +
      "its id among your tasks; pass `name` too for an older run.",
    inputSchema: TasksAssessInput,
  },
  {
    name: "run_batch",
    description:
      "Run one task over many inputs as a batch: a saved task by `taskId`, or an inline " +
      "definition (as tasks__run), once per item of `items` (at most 10,000). Every item is " +
      "checked against the task's inputSchema first; any bad item refuses the whole batch and " +
      "nothing is created. Returns at once with the batch id; the runs go on in the background, " +
      "at most `concurrency` at a time. `budgetUsd` caps the whole batch's spend across all its " +
      "runs; `stopWhen` pauses it when its pass rate collapses. `idempotencyKey` makes the call " +
      "safe to repeat. Follow it with tasks__batch; control it with tasks__batch_control.",
    inputSchema: TasksRunBatchInput,
  },
  {
    name: "batch",
    description:
      "A batch's state, counts (pending, queued, running, pass, fail, uncertain, not_assessed, " +
      "failed, skipped, cancelled), cost, and pass rate. With `results: true` (or a `verdict` " +
      "filter), one page of item results: index, input preview, run id, label, verdict, cost, " +
      "and the structured output's top-level fields. Page with `nextCursor`.",
    inputSchema: TasksBatchInput,
  },
  {
    name: "batch_control",
    description:
      "Pause, resume, cancel, or re-run the failed items of a batch. pause: no new item starts. " +
      "resume: starts items again (with `budgetUsd`, under a new budget). cancel: stops it for " +
      "good, cancelling its queued and running runs. rerun_failed: runs every failed, skipped, " +
      "cancelled, or fail-judged item again as a new run.",
    inputSchema: TasksBatchControlInput,
  },
  {
    name: "batches",
    description: "Your batches in this workspace, newest first, optionally by task or state.",
    inputSchema: TasksBatchesInput,
  },
  {
    name: "cancel",
    description: "Cancel an in-flight task run. Returns whether a run was actually cancelled.",
    inputSchema: TasksCancelInput,
  },
];
