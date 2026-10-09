/**
 * Tool descriptions and annotations for the tasks source. The input schemas
 * live in `src/platform/schemas/tasks.ts`, the single source of truth the
 * in-process source and its handlers share; this file pairs each with its
 * name, description, and spec annotations as the `TOOL_SCHEMAS` array the
 * source registers.
 */

import type { ToolAnnotations } from "@modelcontextprotocol/server";
import {
  TasksAssessInput,
  TasksBatchControlInput,
  TasksBatchesInput,
  TasksBatchInput,
  TasksCancelInput,
  TasksCreateInput,
  TasksDeleteInput,
  TasksJudgesInput,
  TasksListInput,
  TasksRunBatchInput,
  TasksRunInput,
  TasksRunResultInput,
  TasksRunsInput,
  TasksStatsInput,
  TasksStatusInput,
  TasksUpcomingInput,
  TasksUpdateInput,
} from "../schemas/tasks.ts";

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
}

/** A read: changes nothing, and reaches nothing outside this workspace's tasks. */
const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: "create",
    description:
      "Create a task: `manifest` is the definition, `body` the prompt that opens each run. Its " +
      "id is the kebab-case of `manifest.name`, and a name whose id exists is refused (change " +
      "that task with tasks__update). Its schedule recurs (cron, interval), fires once at a set " +
      "time (once), fires on routed notifications (event), or is omitted for a task that runs " +
      "only when someone runs it. Returns the task, the caps its runs execute under, and the " +
      "timezone its schedule is read in. Scope: a task belongs to the workspace it is created " +
      "in and runs as you. A run reaches only that workspace's tools and connectors (including " +
      "personal connectors granted to it) plus your own tools, never another workspace's, so " +
      "create a task that posts to a shared destination in the workspace where that connector " +
      "is. Runs stop while you are not a member of the workspace.",
    inputSchema: TasksCreateInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "update",
    description:
      "Change a task by `taskId`: a `manifest` patch (field names as tasks__create; omitted " +
      "fields keep their values, null clears one so its default applies) and/or a new `body`. " +
      "`enabled: false` pauses its schedule and events; `enabled: true` resumes it and clears an " +
      "automatic disable.",
    inputSchema: TasksUpdateInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "delete",
    description: "Delete a task by `taskId`. Removes the definition; its run history is kept.",
    inputSchema: TasksDeleteInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "list",
    description:
      "Your tasks in this workspace: id, name, schedule in words, enabled, last run, next fire " +
      "(ISO times). Saved tasks only unless `kind` says otherwise. Paged: at most 100 per call " +
      "by default, with `total` reporting every match — follow `nextCursor` before concluding a " +
      "task is absent.",
    inputSchema: TasksListInput,
    annotations: READ,
  },
  {
    name: "status",
    description:
      "One task by `taskId`: its whole definition (prompt, schedule, tools, schemas, criteria), " +
      "its state (enabled, why it was disabled, next fire, error streak, budget use), and its " +
      "most recent runs. For older runs or runs across tasks use tasks__runs.",
    inputSchema: TasksStatusInput,
    annotations: READ,
  },
  {
    name: "runs",
    description:
      "Ended runs, newest first, across your tasks or one (`taskId`), filtered by `label` or " +
      "`verdict`. Each run carries its `execution` (how it ended), its `assessment` when judged, " +
      "and the `label` it reads as (Succeeded, Poor result, Needs review, Failed, Skipped, " +
      'Cancelled). `label: "Needs review"` finds runs awaiting a person\'s verdict ' +
      "(tasks__assess). Output is a preview; tasks__run_result has the whole deliverable. " +
      "History is kept indefinitely: pass the response's `nextBefore` back as `before` for " +
      "older runs. A filtered call reads at most 5000 runs, then answers with `nextBefore`.",
    inputSchema: TasksRunsInput,
    annotations: READ,
  },
  {
    name: "run_result",
    description:
      "One run by `runId`, in whatever state it is. `status` is queued or running while it has " +
      "not ended — an answer, not an error: call again to poll, and never start the run again. " +
      "Once `ended`, `run` is its record (execution, label, assessment) and `result` its full " +
      "deliverable: the untruncated output, the activity log of every tool call, refs to files " +
      "it wrote, usage, and `structured` (the output parsed against the task's outputSchema). " +
      "A run that never started, or failed before any work, has a `result` with an empty " +
      "output and its `error`; `result` is absent only for a run recorded by an older release.",
    inputSchema: TasksRunResultInput,
    annotations: READ,
  },
  {
    name: "run",
    description:
      "Run a task now: a saved one by `taskId`, or a one-off from `definition` (create's " +
      "`{manifest, body}` without name or schedule), which is saved as a `oneoff` task and run " +
      "once. `input` is JSON for the run, checked against the task's inputSchema and given to " +
      "the run as data. Runs a disabled task too; its schedule and events still will not fire " +
      "it. Answers one of three ways: `run`, the run's record, when it ends within ~30s or is " +
      "refused before it starts (status `skipped`, with `error` saying why: already running or " +
      'queued, the run queue full, its budget spent); `status: "dispatched"` with `runId` when ' +
      'it is still running; or `status: "queued"` with `runId` and `position` when every run ' +
      "slot is busy. Follow a dispatched or queued run with tasks__run_result (runId) until it " +
      "says `ended`, and stop it with tasks__cancel (runId); do not call tasks__run again for " +
      "it. `idempotencyKey` makes a retry return the run the first call started. An error " +
      "response means nothing was started (unknown task, bad input, bad definition). " +
      "`warnings` say when the task's criteria cannot be judged.",
    inputSchema: TasksRunInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "assess",
    description:
      "Set your verdict on a run's deliverable ({runId, verdict: 'pass'|'fail', note?}), or " +
      "judge it again with the task's current schema and criteria ({runId, reassess: true}). " +
      "Your verdict is recorded beside the judge's and replaces it in how the run reads " +
      "(its `label`). Only a run that left a deliverable has an assessment. Find runs awaiting " +
      'a verdict with tasks__runs (label: "Needs review").',
    inputSchema: TasksAssessInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "run_batch",
    description:
      "Run one task over many inputs: a saved task by `taskId`, or a one-off from `definition` " +
      "(as tasks__run), once per item of `items` (at most 10,000). Every item is checked " +
      "against the task's inputSchema first; any bad item refuses the whole batch and nothing " +
      "is created. Test the task on one input with tasks__run first. Returns at once with the " +
      "batch; its runs go on in the background, at most `concurrency` at a time. `budgetUsd` " +
      "caps the whole batch's spend; `stopWhen` pauses it when its judged pass rate collapses. " +
      "`idempotencyKey` makes the call safe to repeat. Follow it with tasks__batch; pause, " +
      "resume, cancel, or rerun failures with tasks__batch_control.",
    inputSchema: TasksRunBatchInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "batch",
    description:
      "One batch by `batchId`: its state (and why it paused), counts (pending, queued, running, " +
      "pass, fail, uncertain, not_assessed, failed, skipped, cancelled), cost, and pass rate. " +
      "With `results: true` (or a `filter`), one page of item results: index, input preview, " +
      "run id, label, verdict, cost, and the structured output's top-level fields. Page with " +
      "`nextCursor`. A run's whole deliverable is tasks__run_result (its runId).",
    inputSchema: TasksBatchInput,
    annotations: READ,
  },
  {
    name: "batch_control",
    description:
      "Pause, resume, cancel, or re-run the failed items of a batch. pause: no new item starts. " +
      "resume: starts items again (with `budgetUsd`, under a new budget; a batch paused for " +
      "budget needs one). cancel: stops it for good, cancelling its queued and running runs. " +
      "rerun_failed: runs every failed, skipped, cancelled, or fail-judged item again as a new " +
      "run.",
    inputSchema: TasksBatchControlInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: "batches",
    description:
      "Your batches in this workspace, newest first, optionally by task or state, each with its " +
      "counts and pass rate. One batch's item results are tasks__batch.",
    inputSchema: TasksBatchesInput,
    annotations: READ,
  },
  {
    name: "upcoming",
    description:
      "What runs next among your tasks in this workspace: runs holding a run slot now and runs " +
      "waiting for one (each with its `runId`, its place in the queue, and its batch item when " +
      "it is one), the fires of timed schedules within the next `days` (default 7) soonest " +
      "first, each enabled timed task's next fire even when it is past the window " +
      "(`beyondWindow`), a schedule that fires more than 24 times in the window as one " +
      "`frequent` row with its count, and the tasks events fire (with each one's hourly fire " +
      "ceiling and how much of it the last hour used).",
    inputSchema: TasksUpcomingInput,
    annotations: READ,
  },
  {
    name: "stats",
    description:
      "Per task, since a time (default 30 days ago): how many runs started, their verdicts " +
      "(pass, fail, and uncertain, which is the runs needing review; your verdict replaces the " +
      "judge's), the pass rate pass / (pass + fail), what they cost in USD, and the newest " +
      "run's label. Every saved task, or one by `taskId`.",
    inputSchema: TasksStatsInput,
    annotations: READ,
  },
  {
    name: "judges",
    description:
      "The judge servers connected in this workspace (servers exposing judge and " +
      "list_judges), to name in a task's judge.server, and a warning when a task naming none " +
      "would not be judged (no judge server, or more than one). Check before giving a task " +
      "criteria.",
    inputSchema: TasksJudgesInput,
    annotations: READ,
  },
  {
    name: "cancel",
    description:
      "Cancel one run by `runId`: stop it in flight, or take it out of the queue (recorded " +
      "cancelled). Says whether a run was cancelled; one that already ended is left as it " +
      "is. tasks__upcoming lists the runs queued or running. A whole batch is cancelled with " +
      "tasks__batch_control.",
    inputSchema: TasksCancelInput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];
