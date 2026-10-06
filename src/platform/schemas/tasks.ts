/**
 * Tool input schemas for the tasks app. Imported by both the
 * in-process source (`src/platform/tasks/source.ts`) and the tool
 * handlers beside it (`src/platform/tasks/server.ts`) so the two
 * consumers always agree on the wire shape.
 *
 * Shape convention (per src/platform/AGENTS.md §1.3):
 *
 *   create: { manifest: { ...config }, body: <prompt> }
 *   update: { name, manifest?: Partial<config>, body?: <new prompt> }
 *
 * `manifest` is the persistent task definition; `body` is the prompt
 * that opens each run — the analog of a skill's markdown
 * body. The operator-only field `source` is intentionally absent from the
 * LLM-facing schema; it lives on the stored type and is set by the runtime,
 * never by an authoring caller.
 */

import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";
import { NotificationRouteMatch } from "./notifications.ts";

// ── Shared sub-schemas ───────────────────────────────────────────────────

const Schedule = Type.Object(
  {
    type: StringEnum(["cron", "interval", "event", "once"] as const, {
      description:
        "`cron` and `interval` recur. `once` fires one time, at `at`, and then the task " +
        "is disabled with no next run until a new `at` re-arms it: use it for a single action " +
        "at a set time instead of a cron with a fixed date, which recurs every year. `event` " +
        "has no next run: the task fires when a notification a workspace admin routed to " +
        "it arrives.",
    }),
    expression: Type.Optional(
      Type.String({ description: "5-field cron expression (when type=cron)." }),
    ),
    timezone: Type.Optional(
      Type.String({ description: "IANA timezone. Default: system timezone." }),
    ),
    at: Type.Optional(
      Type.String({
        description:
          "When a once schedule fires (when type=once): an ISO-8601 timestamp with an explicit " +
          "offset, e.g. 2026-07-01T13:12:00-07:00. Must be in the future. A once whose time " +
          "passes while the runtime is down fires on restart if it is at most an hour late, " +
          "and is recorded as skipped otherwise.",
      }),
    ),
    intervalMs: Type.Optional(
      Type.Number({
        minimum: 60000,
        description: "Interval in ms (when type=interval). Min 60000.",
      }),
    ),
    match: Type.Optional(
      Type.Object(NotificationRouteMatch.properties, {
        additionalProperties: false,
        description:
          "Which notifications this task wants (when type=event). Required for an event " +
          "schedule. A workspace admin must ALSO have written a delivery route naming this " +
          "task — this narrows what arrives down that route, it does not open one.",
      }),
    ),
    debounceMs: Type.Optional(
      // Bounds mirror DEFAULT_EVENT_DEBOUNCE_MS / MAX_EVENT_DEBOUNCE_MS in
      // src/platform/tasks/types.ts. Literals for the same reason as
      // maxIterations below: this schema is codegen'd under a strict rootDir
      // that forbids importing from outside src/platform/schemas/.
      Type.Number({
        minimum: 1000,
        maximum: 900000,
        description:
          "How long matching notifications coalesce into one batch before the run starts, in " +
          "ms (when type=event). Default 30000, max 900000. A burst becomes one run with a " +
          "list in it, not one run per item.",
      }),
    ),
    maxFiresPerHour: Type.Optional(
      Type.Number({
        minimum: 1,
        maximum: 60,
        description:
          "Most runs this task may fire from events in a rolling hour (when type=event). " +
          "Default 12, max 60. Exceeding it disables the task — it is what terminates a " +
          "loop in which a run's own work produces the event that fires it again.",
      }),
    ),
  },
  { required: ["type"] },
);

const TokenBudget = Type.Object(
  {
    maxInputTokens: Type.Optional(
      Type.Number({
        minimum: 1,
        description: "Most input tokens this task's runs may use in total per period.",
      }),
    ),
    maxOutputTokens: Type.Optional(
      Type.Number({
        minimum: 1,
        description: "Most output tokens this task's runs may use in total per period.",
      }),
    ),
    period: Type.Optional(
      StringEnum(["daily", "monthly"] as const, {
        description:
          "When the running totals reset: at the start of each day or month. Omit for a " +
          "lifetime total that never resets.",
      }),
    ),
  },
  {
    description:
      "Spending limit across runs, in tokens (not dollars). Checked before each model " +
      "call: each step may write only what is left of the period's budget, and a run with " +
      "too little left for another step stops with stopReason spend_limit. The task " +
      "is then disabled and stays disabled until someone re-enables it. To bound a single " +
      "run, use maxInputTokens and maxIterations. Offer one when the task runs often " +
      "or unattended for long.",
  },
);

/**
 * A JSON Schema an author supplies: an open object, since its keywords are the
 * schema language's, not this tool's.
 */
function jsonSchemaField(description: string) {
  return Type.Unsafe<Record<string, unknown>>({
    type: "object",
    properties: {},
    additionalProperties: true,
    description,
  });
}

const InputSchemaField = jsonSchemaField(
  "JSON Schema each run's `input` must match (tasks__run `input`). A run whose input " +
    "does not match is refused before it starts. Omit to take any JSON input.",
);

const OutputSchemaField = jsonSchemaField(
  "JSON Schema the deliverable must match. The run is told to answer with JSON matching it; " +
    "the final output is parsed and checked, kept as the result's `structured`, and the run " +
    "record says whether it matched (`outputSchemaValid`, `outputSchemaErrors`).",
);

// ── Acceptance criteria and the judge ────────────────────────────────────
//
// Bounds mirror the judge tool contract (1 to 50 criteria, id pattern, rule
// length, 2 to 10 levels, 2 to 255 options), enforced again with the
// cross-field rules a schema cannot state by `validateAssessmentFields` in
// src/platform/tasks/assessment.ts.

const Criterion = Type.Object(
  {
    id: Type.String({
      pattern: "^[A-Za-z0-9_.-]{1,64}$",
      description: "Unique within the task; names the criterion in the assessment.",
    }),
    rule: Type.String({
      minLength: 1,
      maxLength: 4000,
      description:
        'The rule, in plain language, e.g. "Every claim cites a source fetched during this run." ' +
        "A rule can name the run's `input`, `deliverable`, or `activity` (its tool calls).",
    }),
    type: StringEnum(["boolean", "score", "choice"] as const, {
      description:
        "boolean: is the rule true. score: which of the ordered `levels` holds. choice: which of " +
        "the `options` holds.",
    }),
    levels: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 2,
        maxItems: 10,
        description: "score only: the levels, lowest first.",
      }),
    ),
    options: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 2,
        maxItems: 255,
        description: "choice only: the distinct options.",
      }),
    ),
    pass: Type.Optional(
      Type.Union([Type.Boolean(), Type.Integer(), Type.String(), Type.Array(Type.String())], {
        description:
          "What passes. boolean: true (default) or false. score: the lowest passing level index " +
          "(default: the upper half of the levels). choice: the passing option or options " +
          "(required).",
      }),
    ),
  },
  { required: ["id", "rule", "type"] },
);

const CriteriaField = Type.Array(Criterion, {
  minItems: 1,
  maxItems: 50,
  description:
    "Acceptance criteria. After each run that leaves a deliverable, a judge server the " +
    "workspace connected answers every criterion (the deliverable, the input, and a summary " +
    "of the tool calls are sent to it), and the run is recorded pass, fail, or uncertain. " +
    "Without a connected judge server the run is not assessed.",
});

const ConfidenceThresholdField = Type.Number({
  minimum: 0,
  maximum: 1,
  description:
    "Judge confidence below which a run whose criteria all passed is `uncertain` rather than " +
    "`pass`. Default 0.7.",
});

const JudgeField = Type.Object(
  {
    server: Type.Optional(
      Type.String({
        description:
          "The connected judge server to use. Needed only when the workspace has more than one.",
      }),
    ),
    id: Type.Optional(
      Type.String({ description: "A judge from that server's list_judges. Default: its default." }),
    ),
    options: Type.Optional(
      Type.Unsafe<Record<string, unknown>>({
        type: "object",
        properties: {},
        additionalProperties: true,
        description: "That judge's settings (its options_schema). Needs `id`.",
      }),
    ),
  },
  { description: "Which judge answers the criteria. Omit to use the one connected judge server." },
);

const OnPoorResultField = StringEnum(["record", "notify", "retry_once"] as const, {
  description:
    "What a `fail` assessment does. record: nothing more. notify (default): a notification in " +
    "the workspace inbox naming the task and the failed criteria. retry_once: run again once, " +
    "with the failed criteria as guidance.",
});

// Manifest fields shared by create + update. `name` is required for create
// (rebuilt with explicit required); update uses the same fields minus name
// (renames are not patchable; the kebab-case id would drift).
const ManifestFields = {
  name: Type.String({ description: "Human-readable name. Becomes the kebab-case id." }),
  description: Type.Optional(Type.String({ description: "What this task does." })),
  schedule: Type.Optional(
    Type.Object(Schedule.properties, {
      required: ["type"],
      description:
        "What fires it unattended. Omit for a task that runs only when someone runs it " +
        "(tasks__run).",
    }),
  ),
  enabled: Type.Optional(
    Type.Boolean({
      description:
        "Whether its schedule or events fire it. Default true. Run now (tasks__run) runs it either way.",
    }),
  ),
  skill: Type.Optional(
    Type.String({
      description: "Force a specific skill match for this task's runs.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model override. Omit to use the workspace default." }),
  ),
  maxIterations: Type.Optional(
    // Default/cap mirror DEFAULT_MAX_ITERATIONS / MAX_ITERATIONS in src/limits.ts.
    // Kept as a literal because this schema is codegen'd under a strict rootDir
    // (scripts/tsconfig.codegen-web.json) that forbids importing from outside
    // src/platform/schemas/. The enforcement path (server.ts) imports the
    // real constant; this is documentation only.
    Type.Number({
      description:
        "Max LLM iterations per run. Default 25, hard cap 50. Runs are also held to the " +
        "runtime's per-run ceiling; create and update report the effective value.",
    }),
  ),
  maxInputTokens: Type.Optional(
    Type.Number({
      description:
        "Input tokens one run may spend in total, summed over every model call (1000 to " +
        "1000000), counting cache reads. Before each model call the run stops with stopReason " +
        "max_input_tokens if that call's projected input would pass the cap. Omit for no " +
        "per-run cap unless the runtime sets a per-run ceiling, which also bounds a set value; " +
        "create and update report the effective value.",
    }),
  ),
  allowedTools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Tools this task's runs may use, as names or globs: `gmail__*` for a workspace " +
        "connector's tools, `my_gmail__*` for your personal one, `files__read` for one tool. A " +
        "run cannot activate or call a tool outside the list; only nb__search and " +
        "nb__manage_tools pass without being listed, so name any other nb__ tool a run needs " +
        "(nb__use_skill for skills, nb__read_resource for resources). Prefer a `<connector>__*` " +
        "glob, since a connector can rename its tools. Omit or leave empty to allow every tool in the " +
        "workspace. May not name tasks__create, tasks__update, or tasks__delete.",
    }),
  ),
  maxRunDurationMs: Type.Optional(
    Type.Number({
      description:
        "Max wall-clock per run (ms), 10000 to 600000. Default 120000. Runs are also held to " +
        "the runtime's per-run ceiling; create and update report the effective value.",
    }),
  ),
  tokenBudget: Type.Optional(TokenBudget),
  inputSchema: Type.Optional(InputSchemaField),
  outputSchema: Type.Optional(OutputSchemaField),
  criteria: Type.Optional(CriteriaField),
  confidenceThreshold: Type.Optional(ConfidenceThresholdField),
  judge: Type.Optional(JudgeField),
  onPoorResult: Type.Optional(OnPoorResultField),
  kind: Type.Optional(
    StringEnum(["saved", "oneoff"] as const, {
      description:
        "`saved` (default) for a task to keep and list. `oneoff` for one made to be run " +
        "once with no schedule: it is kept with its run history but left out of " +
        "tasks__list unless asked for.",
    }),
  ),
};

// Update is a partial of the create-shape minus `name` and `kind` (a one-off
// does not become a saved task by a patch). `schedule: null` clears the
// schedule, leaving a task that runs only when someone runs it.
const UpdateManifestFields = {
  description: ManifestFields.description,
  schedule: Type.Optional(
    Type.Union([Schedule, Type.Null()], {
      description:
        "New schedule, or null to remove it so nothing fires it unattended. Setting a new once " +
        "`at` on a task that already ran once (or missed its time) re-arms and enables it.",
    }),
  ),
  enabled: ManifestFields.enabled,
  skill: ManifestFields.skill,
  model: ManifestFields.model,
  maxIterations: ManifestFields.maxIterations,
  maxInputTokens: ManifestFields.maxInputTokens,
  allowedTools: ManifestFields.allowedTools,
  maxRunDurationMs: ManifestFields.maxRunDurationMs,
  tokenBudget: ManifestFields.tokenBudget,
  inputSchema: Type.Optional(
    Type.Union([InputSchemaField, Type.Null()], {
      description: "New input schema, or null to remove it so runs take any input.",
    }),
  ),
  outputSchema: Type.Optional(
    Type.Union([OutputSchemaField, Type.Null()], {
      description: "New output schema, or null to remove it so the deliverable is not checked.",
    }),
  ),
  criteria: Type.Optional(
    Type.Union([CriteriaField, Type.Null()], {
      description: "New acceptance criteria (the whole list), or null to remove them.",
    }),
  ),
  confidenceThreshold: Type.Optional(
    Type.Union([ConfidenceThresholdField, Type.Null()], {
      description: "New confidence threshold, or null for the default (0.7).",
    }),
  ),
  judge: Type.Optional(
    Type.Union([JudgeField, Type.Null()], {
      description: "Which judge to use, or null to use the one connected judge server.",
    }),
  ),
  onPoorResult: Type.Optional(
    Type.Union([OnPoorResultField, Type.Null()], {
      description: "What a fail assessment does, or null for the default (notify).",
    }),
  ),
};

// ── Tool input schemas ───────────────────────────────────────────────────

export const TasksCreateInput = Type.Object(
  {
    manifest: Type.Object(ManifestFields, {
      required: ["name"],
      description: "Task definition: identity, schedule, run-time policy.",
    }),
    body: Type.String({
      description:
        "The prompt that opens every run, whatever starts it: its schedule, an event, or " +
        "someone running it. Describe the job, not tool names: a name such as " +
        "`gmail__send_email` changes with how its connector is installed (`my_` for a personal " +
        "one), and a run that cannot find a named tool ends quietly. List the tools in " +
        "`manifest.allowedTools`, where a missing one fails the run.",
    }),
  },
  { required: ["manifest", "body"] },
);
export type TasksCreateInput = Static<typeof TasksCreateInput>;

export const TasksUpdateInput = Type.Object(
  {
    name: Type.String({ description: "Name of the task to update." }),
    manifest: Type.Optional(
      Type.Object(UpdateManifestFields, {
        description: "Partial manifest patch. Omitted fields keep their current values.",
      }),
    ),
    body: Type.Optional(
      Type.String({ description: "New prompt. Omit to keep the current prompt." }),
    ),
  },
  { required: ["name"] },
);
export type TasksUpdateInput = Static<typeof TasksUpdateInput>;

export const TasksDeleteInput = Type.Object(
  { name: Type.String({ description: "Name of the task to delete." }) },
  { required: ["name"] },
);
export type TasksDeleteInput = Static<typeof TasksDeleteInput>;

export const TasksListInput = Type.Object({
  enabled: Type.Optional(Type.Boolean({ description: "Filter by enabled status." })),
  source: Type.Optional(
    StringEnum(["user", "agent"] as const, { description: "Filter by source." }),
  ),
  kind: Type.Optional(
    StringEnum(["saved", "oneoff", "all"] as const, {
      description: "Which kind to list. Default `saved`; `oneoff` or `all` to include one-offs.",
    }),
  ),
  limit: Type.Optional(
    // Default/cap mirror TASKS_LIST_DEFAULT_LIMIT / TASKS_LIST_MAX_LIMIT
    // in src/limits.ts. Literals for the same reason as maxIterations above: this
    // schema is codegen'd under a strict rootDir that forbids importing from
    // outside src/platform/schemas/. server.ts imports the real constants.
    Type.Integer({
      minimum: 1,
      maximum: 500,
      description:
        "Max tasks to return. Default 100, max 500. The response always reports the unpaged total and whether more remain.",
    }),
  ),
  cursor: Type.Optional(
    Type.String({
      description:
        "Opaque pagination cursor from a previous response's `nextCursor`. Omit for the first page.",
    }),
  ),
});
export type TasksListInput = Static<typeof TasksListInput>;

export const TasksStatusInput = Type.Object(
  {
    name: Type.String({ description: "Name of the task." }),
    limit: Type.Optional(Type.Number({ description: "Max recent runs to include. Default: 5." })),
  },
  { required: ["name"] },
);
export type TasksStatusInput = Static<typeof TasksStatusInput>;

export const TasksRunsInput = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Filter by task ID." })),
  status: Type.Optional(
    StringEnum(
      ["running", "success", "degraded", "failure", "timeout", "cancelled", "skipped"] as const,
      {
        description: "Filter by run status.",
      },
    ),
  ),
  since: Type.Optional(
    Type.String({
      description: "ISO timestamp — only runs started on or after this time.",
    }),
  ),
  before: Type.Optional(
    Type.String({
      description:
        "ISO timestamp — only runs started before this time. Pages back through the full run " +
        "history, which is kept indefinitely: pass the previous response's `nextBefore`, with " +
        "or without `taskId`. Without it, only the most recent runs (up to 1000 per task) are " +
        "read, so pass a time just ahead of now to page every run back through the archives.",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max runs to return. Default: 20." })),
  excludeBatchRuns: Type.Optional(
    Type.Boolean({
      description: "true: leave out runs that are items of a batch (read those with tasks__batch).",
    }),
  ),
});
export type TasksRunsInput = Static<typeof TasksRunsInput>;

export const TasksUpcomingInput = Type.Object({
  days: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 30,
      description:
        "How many days ahead to list scheduled fires. Default 7, max 30. Every enabled timed " +
        "task's next fire is listed even when it falls past the window.",
    }),
  ),
});
export type TasksUpcomingInput = Static<typeof TasksUpcomingInput>;

export const TasksStatsInput = Type.Object({
  since: Type.Optional(
    Type.String({
      description: "ISO timestamp: count runs started on or after it. Default: 30 days ago.",
    }),
  ),
  taskId: Type.Optional(
    Type.String({ description: "Only this task (any kind). Default: every saved task." }),
  ),
});
export type TasksStatsInput = Static<typeof TasksStatsInput>;

export const TasksJudgesInput = Type.Object({});
export type TasksJudgesInput = Static<typeof TasksJudgesInput>;

export const TasksRunInput = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description:
        "The saved task to run (its id, as tasks__list returns it). Omit it and give " +
        "`prompt` (or `skill`) instead to run an inline one-off: a `oneoff` task with no " +
        "schedule is created, owned by you in this workspace, run once, and kept with its run.",
    }),
  ),
  input: Type.Optional(
    Type.Unsafe<unknown>({
      description:
        "JSON input for this run (any JSON value, at most 64 KiB serialized). Checked against " +
        "the task's inputSchema when it has one, kept on the run record, and given to " +
        "the run as data, never as instructions.",
    }),
  ),
  idempotencyKey: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 256,
      description:
        "Repeat-safe key. A later call with the same key for the same task (or the same " +
        "inline one-off) returns the run the first call started instead of starting another.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({ description: "Inline one-off: the prompt that opens the run." }),
  ),
  skill: Type.Optional(
    Type.String({ description: "Inline one-off: a skill for the run to carry out." }),
  ),
  inputSchema: Type.Optional(InputSchemaField),
  outputSchema: Type.Optional(OutputSchemaField),
  allowedTools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Inline one-off: the tools the run may use, as names or globs (see tasks__create).",
    }),
  ),
  limits: Type.Optional(
    Type.Object(
      {
        maxIterations: ManifestFields.maxIterations,
        maxInputTokens: ManifestFields.maxInputTokens,
        maxRunDurationMs: ManifestFields.maxRunDurationMs,
      },
      {
        additionalProperties: false,
        description: "Inline one-off: per-run caps, as on tasks__create.",
      },
    ),
  ),
  budget: Type.Optional(TokenBudget),
  criteria: Type.Optional(CriteriaField),
  confidenceThreshold: Type.Optional(ConfidenceThresholdField),
  judge: Type.Optional(JudgeField),
  onPoorResult: Type.Optional(OnPoorResultField),
});
export type TasksRunInput = Static<typeof TasksRunInput>;

export const TasksAssessInput = Type.Object(
  {
    runId: Type.String({ description: "The run to assess." }),
    name: Type.Optional(
      Type.String({
        description:
          "Name of the run's task. Optional: a run is found among your tasks by its id alone.",
      }),
    ),
    verdict: Type.Optional(
      StringEnum(["pass", "fail"] as const, {
        description:
          "Your verdict on the run's deliverable. It replaces the judge's in how the run reads.",
      }),
    ),
    note: Type.Optional(
      Type.String({ maxLength: 2000, description: "Why, in a sentence or two (with `verdict`)." }),
    ),
    reassess: Type.Optional(
      Type.Boolean({
        description:
          "true: judge the run again with the task's current schema and criteria (after editing " +
          "them). Give this or `verdict`, not both.",
      }),
    ),
  },
  { required: ["runId"] },
);
export type TasksAssessInput = Static<typeof TasksAssessInput>;

export const TasksCancelInput = Type.Object(
  { name: Type.String({ description: "Name of the task to cancel." }) },
  { required: ["name"] },
);
export type TasksCancelInput = Static<typeof TasksCancelInput>;

export const TasksRunResultInput = Type.Object(
  {
    name: Type.Optional(
      Type.String({
        description:
          "Name of the task. Optional for a run tasks__run started, which is found " +
          "by its id alone.",
      }),
    ),
    runId: Type.String({ description: "The run id (from a run record) to fetch the result for." }),
  },
  { required: ["runId"] },
);
export type TasksRunResultInput = Static<typeof TasksRunResultInput>;

// ── Batches ──────────────────────────────────────────────────────────────

const BatchIdField = Type.String({
  pattern: "^batch_[a-f0-9]{12}$",
  description: "The batch's id (tasks__run_batch returns it).",
});

export const TasksRunBatchInput = Type.Object(
  {
    taskId: Type.Optional(
      Type.String({
        description:
          "The saved task every item runs. Omit it and give `prompt` (or `skill`) instead to " +
          "run an inline definition: a `oneoff` task is created for the batch.",
      }),
    ),
    items: Type.Array(
      Type.Unsafe<unknown>({
        description: "One run's JSON input, checked against the task's inputSchema.",
      }),
      {
        minItems: 1,
        maxItems: 10000,
        description:
          "The inputs, one run each (at most 10,000; each at most 64 KiB serialized, 16 MiB " +
          "together). Every item is checked against the task's inputSchema first: if any fails, " +
          "the whole batch is refused (naming the first bad indices) and nothing is created.",
      },
    ),
    concurrency: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description:
          "Most of the batch's runs at once (queued or running). Held to the runtime's " +
          "concurrent-run limit, which is also the default; the runtime's fair share between " +
          "workspaces applies on top.",
      }),
    ),
    budgetUsd: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        description:
          "Whole-batch ceiling in USD, checked before every model call across all of the batch's " +
          "runs at once. When too little is left, no new item starts and the batch pauses " +
          "(resume can raise it).",
      }),
    ),
    stopWhen: Type.Optional(
      Type.Object(
        {
          minPassRate: Type.Number({
            minimum: 0,
            maximum: 1,
            description: "Pause when pass / (pass + fail) falls below this (0..1).",
          }),
          afterItems: Type.Integer({
            minimum: 1,
            description: "Assessed runs (pass, fail, or uncertain) before the rule applies.",
          }),
        },
        {
          required: ["minPassRate", "afterItems"],
          additionalProperties: false,
          description:
            "Pause the batch when its pass rate collapses. Uncertain results are excluded, so " +
            "judge doubt alone never pauses it. Needs a task with criteria or an outputSchema.",
        },
      ),
    ),
    idempotencyKey: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 256,
        description: "Repeat-safe key: a later call with the same key returns the same batch.",
      }),
    ),
    prompt: Type.Optional(
      Type.String({ description: "Inline definition: the prompt that opens each run." }),
    ),
    skill: Type.Optional(
      Type.String({ description: "Inline definition: a skill for each run to carry out." }),
    ),
    inputSchema: Type.Optional(InputSchemaField),
    outputSchema: Type.Optional(OutputSchemaField),
    allowedTools: Type.Optional(
      Type.Array(Type.String(), {
        description: "Inline definition: the tools each run may use (see tasks__create).",
      }),
    ),
    limits: Type.Optional(
      Type.Object(
        {
          maxIterations: ManifestFields.maxIterations,
          maxInputTokens: ManifestFields.maxInputTokens,
          maxRunDurationMs: ManifestFields.maxRunDurationMs,
        },
        {
          additionalProperties: false,
          description: "Inline definition: per-run caps, as on tasks__create.",
        },
      ),
    ),
    budget: Type.Optional(TokenBudget),
    criteria: Type.Optional(CriteriaField),
    confidenceThreshold: Type.Optional(ConfidenceThresholdField),
    judge: Type.Optional(JudgeField),
    onPoorResult: Type.Optional(OnPoorResultField),
  },
  { required: ["items"] },
);
export type TasksRunBatchInput = Static<typeof TasksRunBatchInput>;

/** What `tasks__batch` `verdict` filters results to. `failing` is fail plus failed. */
const BatchResultFilter = StringEnum(
  [
    "pass",
    "fail",
    "uncertain",
    "not_assessed",
    "failed",
    "skipped",
    "cancelled",
    "pending",
    "failing",
  ] as const,
  {
    description:
      "Only items in this state: a verdict (pass, fail, uncertain, not_assessed), an execution " +
      "without a deliverable (failed, skipped, cancelled), pending (not ended), or failing " +
      "(fail or failed).",
  },
);

export const TasksBatchInput = Type.Object(
  {
    batchId: BatchIdField,
    results: Type.Optional(
      Type.Boolean({
        description:
          "true: include item results, a page at a time. A verdict, cursor, or limit also asks for them.",
      }),
    ),
    verdict: Type.Optional(BatchResultFilter),
    cursor: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Item index to start the page at: the previous page's `nextCursor`.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 500, description: "Items per page. Default 50." }),
    ),
  },
  { required: ["batchId"] },
);
export type TasksBatchInput = Static<typeof TasksBatchInput>;

export const TasksBatchControlInput = Type.Object(
  {
    batchId: BatchIdField,
    action: StringEnum(["pause", "resume", "cancel", "rerun_failed"] as const, {
      description:
        "pause: no new item starts; runs still queued are taken back, runs in flight finish. resume: start items again. " +
        "cancel: stop for good, cancelling queued and running runs. rerun_failed: run again, " +
        "each as a new run, every item that failed, was skipped or cancelled, or was judged fail.",
    }),
    budgetUsd: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        description:
          "With resume of a paused batch: the budget to resume under (more than already spent). " +
          "A running batch refuses it (pause first), and so does one whose runs sharing the old " +
          "budget are still in flight.",
      }),
    ),
  },
  { required: ["batchId", "action"] },
);
export type TasksBatchControlInput = Static<typeof TasksBatchControlInput>;

export const TasksBatchesInput = Type.Object({
  taskId: Type.Optional(Type.String({ description: "Only batches of this task." })),
  state: Type.Optional(
    StringEnum(["running", "paused", "completed", "cancelled"] as const, {
      description: "Only batches in this state.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 100, description: "Most batches. Default 20." }),
  ),
});
export type TasksBatchesInput = Static<typeof TasksBatchesInput>;

// ── Tool output types ────────────────────────────────────────────────────
//
// These are TYPE-ONLY exports — no TypeBox runtime schema. The handler in
// `src/platform/tasks/server.ts` is the authority on output shape;
// these types track it for consumers (CLI, integration tests, web client,
// any future caller) so a single change point catches drift at compile
// time instead of at agent-confusion time.
//
// Why no runtime schema for outputs: we don't validate outputs at the
// MCP boundary — the handler's TypeScript return type already constrains
// it, and Pydantic-style runtime checks would just duplicate that
// constraint at the cost of an extra serialization round-trip. Outputs
// are checked at the seams that matter (per-call-site, via these types).
//
// Why these are self-contained (not imported from
// `src/platform/tasks/types.ts`): the codegen at
// `scripts/codegen-web-platform-schemas.ts`
// emits .d.ts files for the web package with `rootDir` pinned to
// `schemas/`. Cross-tree imports break that boundary. Drift between
// these types and the canonical `Task` / `TaskRun` is
// guarded at COMPILE time by
// `src/platform/tasks/output-types-drift-guard.ts`, which
// `bun run check` validates as part of the standard CI gate. When you
// change `Task` or `TaskRun`, that file's type-level
// constraints fail to compile against the corresponding mirror here —
// the build error points at the field that drifted.
//
// When you change a handler return shape, update the matching output
// type here in the same commit. The output type is the contract.

/**
 * Status of the most recent task run, as exposed via the list/
 * summary surface. Mirrors `TaskRun["status"]` minus `"running"`
 * — the list view shows the most recent COMPLETED run's outcome, never
 * one in flight.
 */
export type TaskLastRunStatus = "success" | "degraded" | "failure" | "timeout" | "skipped";

/**
 * Summary row returned per task by `handleList`. Subset of the
 * stored `Task` shape plus a couple of human-formatted fields the
 * UI surfaces directly. `lastRunAt` / `nextRunAt` are human-relative
 * strings (e.g. "in 2h", "4h ago") — the raw ISO timestamps stay on the
 * stored `Task`.
 */
export interface TaskSummary {
  id: string;
  name: string;
  description?: string;
  /** Human-readable trigger, e.g. "Weekdays at 8:00 AM HST", "Once at …", "Manual only". */
  schedule: string;
  /** The schedule's type, or `none` when nothing fires it unattended. */
  scheduleType: "cron" | "interval" | "event" | "once" | "none";
  kind: "saved" | "oneoff";
  /** Set when a once schedule has fired or missed its time; the task is inert until re-armed. */
  onceDone?: TaskOnceDone;
  enabled: boolean;
  source: "user" | "agent";
  runCount: number;
  lastRunStatus: TaskLastRunStatus | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  estimatedCostPerDay: number;
  /** The task's input schema, when it has one: a caller can ask for the input before it runs. */
  inputSchema?: Record<string, unknown>;
}

export interface TasksListOutput {
  tasks: TaskSummary[];
  /** Matches for the given filters BEFORE the page cap — not `tasks.length`. */
  total: number;
  /** How many are in this response. */
  returned: number;
  /**
   * Pass as `cursor` to get the next page; `null` when this is the last one.
   *
   * A cursor rather than a numeric offset because the page must stay correct
   * across a mutation between calls: an offset re-slices a list whose earlier
   * entries may have been deleted, which silently skips the records that
   * shifted past the boundary. Anchoring to the last id read means a deletion
   * behind the cursor cannot move the records ahead of it.
   */
  nextCursor: string | null;
  hasMore: boolean;
  /**
   * Present only when the page cap hid matches. Prose rather than a flag alone
   * because the consumer is a model reading the payload: a bare `hasMore: true`
   * has been read as incidental, whereas a sentence naming the missing count is
   * not. Coverage that silently shrinks is worse than an error — the caller
   * concludes "no match found" from a set it never saw.
   */
  truncated?: string;
}

/** One acceptance criterion. Mirror of `Criterion`. */
export interface TaskCriterion {
  id: string;
  rule: string;
  type: "boolean" | "score" | "choice";
  levels?: string[];
  options?: string[];
  pass?: boolean | number | string | string[];
}

/** Which judge answers a task's criteria. Mirror of `TaskJudge`. */
export interface TaskJudgeSpec {
  server?: string;
  id?: string;
  options?: Record<string, unknown>;
}

/** One criterion as judged and decided. Mirror of `CriterionResult`. */
export interface TaskCriterionResult {
  id: string;
  answer: boolean | number | string;
  passed: boolean;
  confidence: number;
  probabilities?: Record<string, number>;
  rationale?: string;
}

/** A person's verdict on a run. Mirror of `HumanVerdict`. */
export interface TaskHumanVerdict {
  verdict: "pass" | "fail";
  note?: string;
  by: string;
  via: "ui" | "remote";
  at: string;
}

/** Whether a run's deliverable is acceptable. Mirror of `RunAssessment`. */
export interface TaskRunAssessment {
  verdict: "pass" | "fail" | "uncertain" | "not_assessed";
  reason?: { code: string; message: string };
  schema?: { valid: boolean; errors?: string[] };
  criteria?: TaskCriterionResult[];
  judge?: { server: string; id: string; version?: string; calibrated: boolean };
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  stateTruncated?: boolean;
  assessedAt: string;
  human?: TaskHumanVerdict;
}

/** How a run ended (ADR-0045), derived from its record. Mirror of `RunExecution`. */
export type TaskRunExecution =
  | "queued"
  | "running"
  | "skipped"
  | "completed"
  | "incomplete"
  | "failed"
  | "cancelled";

/** The one label a run reads as, derived and never stored. Mirror of `RunLabel`. */
export type TaskRunLabel =
  | "Succeeded"
  | "Poor result"
  | "Needs review"
  | "Failed"
  | "Skipped"
  | "Cancelled"
  | "Queued"
  | "Running";

/**
 * Structural mirror of a single TaskRun record as returned by
 * the handlers. Kept in sync with `TaskRun` in
 * `platform/tasks/types.ts` via the assertion test referenced
 * above. New fields added there MUST also appear here.
 */
export interface TaskRunRecord {
  id: string;
  taskId: string;
  startedAt: string;
  completedAt?: string;
  status:
    | "queued"
    | "running"
    | "success"
    | "degraded"
    | "failure"
    | "timeout"
    | "cancelled"
    | "skipped";
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  iterations: number;
  error?: string;
  transient?: boolean;
  trigger?: "scheduled" | "manual" | "event";
  resultPreview?: string;
  stopReason?:
    | "complete"
    | "max_iterations"
    | "max_input_tokens"
    | "spend_limit"
    | "length"
    | "content_filter"
    | "error"
    | "other";
  /** The spend account that stopped the run, when `stopReason` is `spend_limit`. */
  spendAccountId?: string;
  /** The JSON input the run was given. */
  input?: unknown;
  /** The idempotency key the run was requested with. */
  idempotencyKey?: string;
  /** Whether the deliverable matched the task's outputSchema; absent without one. */
  outputSchemaValid?: boolean;
  /** Why the deliverable did not match the outputSchema. */
  outputSchemaErrors?: string[];
  /** Tools whose failed calls no later call made good. */
  unrecoveredToolFailures?: string[];
  /** Whether the deliverable is acceptable; absent until assessed. */
  assessment?: TaskRunAssessment;
  /** The run this one retries. */
  retryOf?: string;
  /** The batch this run is an item of. */
  batchId?: string;
  /** The item's index in its batch. */
  batchIndex?: number;
  /** What the run's model calls cost, in USD. */
  costUsd?: number;
}

/**
 * A run record as the run surfaces return it (`tasks__runs`,
 * `tasks__status`, `tasks__run`, `tasks__assess`): the stored record plus
 * its derived execution and label, which are computed on read and never
 * stored.
 */
export type TaskRunView = TaskRunRecord & {
  execution: TaskRunExecution;
  label: TaskRunLabel;
};

/**
 * One tool call from a run's activity log. Mirror of `RunToolCall` in
 * `platform/tasks/types.ts` (kept here to avoid a cross-tree import;
 * see the top-of-section note).
 */
export interface RunToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  output: string;
  ok: boolean;
  ms: number;
}

/** A ref to a file a run produced. Mirror of `RunFileRef`. */
export interface RunFileRefRecord {
  id: string;
  filename: string;
}

/**
 * The full deliverable of a run, returned by `handleRunResult`. Mirror of
 * `TaskRunResult` in `platform/tasks/types.ts`. A run is not a
 * conversation: the result carries the final output, the activity log, and refs
 * to any files the run wrote in the workspace file store.
 */
export interface TasksRunResultOutput {
  runId: string;
  taskId: string;
  completedAt: string;
  output: string;
  activityLog: RunToolCallRecord[];
  outputFiles: RunFileRefRecord[];
  usage: { inputTokens: number; outputTokens: number; iterations: number };
  stopReason?:
    | "complete"
    | "max_iterations"
    | "max_input_tokens"
    | "spend_limit"
    | "length"
    | "content_filter"
    | "error"
    | "other";
  /** The deliverable parsed as JSON, when the task has an outputSchema and it parsed. */
  structured?: unknown;
  /** How the run ended, from its record; absent when the record was not found. */
  execution?: TaskRunExecution;
  /** The label the run reads as, from its record; absent when the record was not found. */
  label?: TaskRunLabel;
  /** The run's assessment, from its record. */
  assessment?: TaskRunAssessment;
}

/**
 * Token budget block on a stored task. Mirror of the
 * `TokenBudget` interface; kept here to avoid a cross-tree import
 * (see top-of-section comment).
 */
export interface TaskTokenBudget {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  period?: "daily" | "monthly";
}

/** How a once schedule's occurrence ended, and when. Mirror of `OnceDone`. */
export interface TaskOnceDone {
  at: string;
  outcome: "ran" | "missed";
}

/**
 * Schedule spec block on a stored task. Mirror of `ScheduleSpec`.
 */
export interface TaskScheduleSpec {
  type: "cron" | "interval" | "event" | "once";
  expression?: string;
  timezone?: string;
  at?: string;
  intervalMs?: number;
  match?: NotificationRouteMatch;
  debounceMs?: number;
  maxFiresPerHour?: number;
}

/**
 * Task detail returned by `handleStatus`. Spreads the stored
 * Task and overlays a few computed fields the UI consumes
 * directly: humanized schedule + relative-time strings, cost numbers,
 * and undefined→null coercion on optional fields (`tokenBudget`,
 * `budgetResetAt`) so JSON consumers see a consistent shape per field.
 */
export interface TaskStatusDetail {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  schedule?: TaskScheduleSpec;
  kind?: "saved" | "oneoff";
  onceDone?: TaskOnceDone;
  scheduleHuman: string;
  enabled: boolean;
  source: "user" | "agent";
  ownerId?: string;
  workspaceId?: string;
  model?: string | null;
  skill?: string;
  allowedTools?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  criteria?: TaskCriterion[];
  confidenceThreshold?: number;
  judge?: TaskJudgeSpec;
  onPoorResult?: "record" | "notify" | "retry_once";
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  runCount: number;
  consecutiveErrors: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  tokenBudget: TaskTokenBudget | null;
  budgetResetAt: string | null;
  lastRunAt?: string;
  lastRunAtHuman: string | null;
  lastRunStatus?: TaskLastRunStatus;
  nextRunAt?: string;
  nextRunAtHuman: string | null;
  disabledAt?: string;
  disabledReason?: string;
  createdAt: string;
  updatedAt: string;
  actualCostUsd: number;
  estimatedCostPerRun: number;
  estimatedCostPerDay: number;
  estimatedCostPerMonth: number;
}

export interface TasksStatusOutput {
  task: TaskStatusDetail;
  recentRuns: TaskRunView[];
}

export interface TasksRunsOutput {
  runs: TaskRunView[];
  total: number;
  /**
   * Pass as `before` for the next older page, of one task's history or of
   * every task's; absent when nothing older remains. A first page read without
   * `before` reads only the hot indexes, so across every task it reports more
   * only when the hot indexes hold more.
   */
  nextBefore?: string;
}

/**
 * A warning a write returns about the task it saved, which it saved anyway.
 * `no_judge`, `judge_ambiguous`, `judge_not_found`: the task has criteria and
 * its workspace has no judge server it can use (none connected, several and
 * none named, or the named one is not a connected judge), so its runs are
 * `uncertain` (Needs review) until one is connected or named.
 */
export interface TaskWarning {
  code: "no_judge" | "judge_ambiguous" | "judge_not_found";
  message: string;
}

/**
 * Discriminated union — `handleRun` returns one of two shapes:
 *
 *   { run: TaskRunRecord; enabled; message? }  when the run finishes
 *                                                    inside the sync-wait
 *                                                    window (~30s default).
 *
 *   { status: "dispatched"; taskId;            when the run is still
 *     startedAt; enabled; message }                  in flight after the
 *                                                    window. It keeps going;
 *                                                    its record lands in
 *                                                    `tasks__runs`
 *                                                    (`since: startedAt`)
 *                                                    when it ends.
 *
 *   { status: "queued"; taskId; position;     when every run slot was
 *     queuedAt; enabled; message }                   busy. It starts as soon
 *                                                    as a slot frees; its record
 *                                                    lands in `tasks__runs`
 *                                                    (`since: queuedAt`) when it
 *                                                    ends. `tasks__cancel`
 *                                                    removes it from the queue.
 *
 * A Run now the scheduler refuses (already running or queued, a full queue, a
 * spent token budget) returns the first shape with a `skipped` run whose
 * `error` says why.
 *
 * `enabled` is the task's own flag. Run now runs a disabled task,
 * because it is a deliberate act and the create form's test run depends on
 * it; a disabled task is not fired by its schedule or by events, and
 * `message` says so.
 *
 * Both shapes indicate the dispatch succeeded; only an error response
 * indicates failure to dispatch. Consumers MUST narrow before
 * dereferencing `run.*` — `as { run: ... }` is the anti-pattern that
 * caused the production CLI crash this type prevents.
 */
export type TasksRunOutput =
  | { run: TaskRunView; enabled: boolean; message?: string; warnings?: TaskWarning[] }
  | {
      status: "dispatched";
      taskId: string;
      /** The run's id: read its result with tasks__run_result. */
      runId: string;
      startedAt: string;
      enabled: boolean;
      message: string;
      warnings?: TaskWarning[];
    }
  | {
      status: "queued";
      taskId: string;
      /** The run's id: read its result with tasks__run_result. */
      runId: string;
      /** 1 is next to start. */
      position: number;
      queuedAt: string;
      enabled: boolean;
      message: string;
      warnings?: TaskWarning[];
    };

/** `tasks__assess`: the run's record with its new assessment, as it now reads. */
export interface TasksAssessOutput {
  run: TaskRunView;
  message: string;
}

export interface TasksCancelOutput {
  cancelled: boolean;
  id: string;
  message: string;
}

/**
 * A stored task, as `tasks__create` and `tasks__update`
 * return it. Mirror of `Task` (`src/platform/tasks/types.ts`),
 * held to it by `src/platform/tasks/output-types-drift-guard.ts`.
 */
export interface TaskRecord {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  schedule?: TaskScheduleSpec;
  kind?: "saved" | "oneoff";
  onceDone?: TaskOnceDone;
  skill?: string;
  allowedTools?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  criteria?: TaskCriterion[];
  confidenceThreshold?: number;
  judge?: TaskJudgeSpec;
  onPoorResult?: "record" | "notify" | "retry_once";
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  model?: string | null;
  enabled: boolean;
  ownerId?: string;
  workspaceId?: string;
  source: "user" | "agent";
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: TaskLastRunStatus;
  nextRunAt?: string;
  runCount: number;
  consecutiveErrors: number;
  disabledAt?: string;
  disabledReason?: string;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  tokenBudget?: TaskTokenBudget;
  budgetResetAt?: string;
}

/**
 * The caps a run of the task executes under: each cap the definition
 * sets, lowered to the runtime's per-run ceiling, and the runtime default held
 * to the ceiling where it sets none. `maxInputTokens` is absent when the run
 * has no input-token cap (neither the definition nor the runtime sets one).
 * `message` names any cap that was lowered.
 */
export interface TaskEffectiveLimits {
  maxIterations: number;
  maxInputTokens?: number;
  maxRunDurationMs: number;
}

export interface TasksCreateOutput {
  task: TaskRecord;
  created: boolean;
  message: string;
  effectiveLimits: TaskEffectiveLimits;
  /** About the saved task, which was saved anyway. */
  warnings?: TaskWarning[];
}

export interface TasksUpdateOutput {
  task: TaskRecord;
  updated: boolean;
  message: string;
  effectiveLimits: TaskEffectiveLimits;
  /** About the saved task, which was saved anyway. */
  warnings?: TaskWarning[];
}

export interface TasksDeleteOutput {
  deleted: boolean;
  id: string;
  message: string;
}

// ── Batch outputs ────────────────────────────────────────────────────────

/** How many of a batch's items are in each state. Mirror of `BatchCounts`. */
export interface TaskBatchCounts {
  pending: number;
  queued: number;
  running: number;
  pass: number;
  fail: number;
  uncertain: number;
  not_assessed: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

/** A stored batch. Mirror of `Batch` (`src/platform/tasks/types.ts`). */
export interface TaskBatchRecord {
  id: string;
  taskId: string;
  workspaceId: string;
  ownerId: string;
  items: number;
  concurrency: number;
  budgetUsd?: number;
  stopWhen?: { minPassRate: number; afterItems: number };
  stopRuleDisarmed?: boolean;
  state: "running" | "paused" | "completed" | "cancelled";
  pause?: {
    reason: "manual" | "budget" | "pass_rate" | "unavailable";
    message: string;
    at: string;
  };
  counts: TaskBatchCounts;
  costUsd: number;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  createdBy: string;
}

/** A batch as the batch tools return it: the record plus figures derived on read. */
export type TaskBatchView = TaskBatchRecord & {
  /** Items with an outcome. */
  done: number;
  /** pass / (pass + fail); null before either. Uncertain is excluded. */
  passRate: number | null;
};

/** One item's result row (`tasks__batch` with `results: true`). */
export interface TaskBatchItemView {
  index: number;
  /** The item's input as JSON, cut to a short preview. */
  inputSummary: string;
  state: "pending" | "queued" | "running" | "done";
  runId?: string;
  previousRunIds?: string[];
  execution?: TaskRunExecution;
  verdict?: "pass" | "fail" | "uncertain" | "not_assessed";
  /** The label the item's run reads as, from its execution and verdict. */
  label?: TaskRunLabel;
  costUsd?: number;
  error?: string;
  /** The top-level scalar fields of the run's structured output, when it has one. */
  output?: Record<string, string | number | boolean | null>;
}

export interface TasksRunBatchOutput {
  batch: TaskBatchView;
  /** True when an earlier call with the same idempotencyKey made this batch. */
  existing: boolean;
  message: string;
  warnings?: TaskWarning[];
}

export interface TasksBatchOutput {
  batch: TaskBatchView;
  /** With `results: true`: one page of items, in index order. */
  results?: TaskBatchItemView[];
  /** Pass as `cursor` for the next page; absent on the last. */
  nextCursor?: number;
}

export interface TasksBatchControlOutput {
  batch: TaskBatchView;
  message: string;
  /** Items the action touched. */
  affected: number;
}

export interface TasksBatchesOutput {
  batches: TaskBatchView[];
}

// ── Views: what runs next, run statistics, judges ────────────────────────

/** A run that holds a run slot or waits for one (`tasks__upcoming`). */
export interface TaskUpcomingRun {
  taskId: string;
  /** Absent when the task's definition is gone. */
  taskName?: string;
  runId?: string;
  state: "running" | "queued";
  /** Queued only: 1 is next (the numbering of tasks__run's queued answer). */
  position?: number;
  /** Running only. */
  startedAt?: string;
  /** Queued only: when the run was asked for, when it has a ticket. */
  queuedAt?: string;
  trigger?: "scheduled" | "manual" | "event";
  batchId?: string;
  batchIndex?: number;
}

/** One coming fire of a timed schedule. */
export interface TaskUpcomingFire {
  taskId: string;
  taskName: string;
  at: string;
  /** Human-readable schedule. */
  schedule: string;
  scheduleType: "cron" | "interval" | "once";
  /** Past the window: the task's next fire, shown so a rare schedule is not missing. */
  beyondWindow?: boolean;
}

/**
 * A schedule that fires more often than the panel lists one by one: one row
 * with how many times it fires in the window, and its first and last fire.
 */
export interface TaskUpcomingFrequent {
  taskId: string;
  taskName: string;
  schedule: string;
  scheduleType: "cron" | "interval";
  /** Fires within the window; a floor when `countCapped`. */
  count: number;
  /**
   * True when a cron was counted only until it was known to be frequent, so
   * `count` is a floor (shown as "25+"). An interval is always counted exactly.
   */
  countCapped?: boolean;
  first: string;
  /** The last fire in the window; absent when `countCapped`. */
  last?: string;
}

/** A task an event fires, with its fire ceiling and how much of it the last hour used. */
export interface TaskUpcomingEventTask {
  taskId: string;
  taskName: string;
  schedule: string;
  enabled: boolean;
  maxFiresPerHour: number;
  firesLastHour: number;
}

export interface TasksUpcomingOutput {
  running: TaskUpcomingRun[];
  queued: TaskUpcomingRun[];
  /** The window's length in days. */
  days: number;
  /** Where the window ends. */
  windowEnd: string;
  /** Fires within the window, soonest first, then each task's next fire past it. */
  scheduled: TaskUpcomingFire[];
  /** Schedules firing more than the listing threshold in the window, one row each, by first fire. */
  frequent: TaskUpcomingFrequent[];
  events: TaskUpcomingEventTask[];
}

/** One task's runs since a time (`tasks__stats`). */
export interface TaskRunStats {
  taskId: string;
  /** Run records started on or after `since`, batch runs included. */
  runs: number;
  /** Verdicts over those runs; a person's verdict replaces the judge's. */
  pass: number;
  fail: number;
  uncertain: number;
  /** pass / (pass + fail); null when both are 0. */
  passRate: number | null;
  /** What those runs cost, in USD (runs with no recorded cost count 0). */
  costUsd: number;
  /** The newest run, whenever it started. */
  lastRun?: { id: string; startedAt: string; label: TaskRunLabel };
}

export interface TasksStatsOutput {
  since: string;
  tasks: TaskRunStats[];
}

/** The judge servers connected in the workspace (`tasks__judges`). */
export interface TasksJudgesOutput {
  servers: string[];
  /** Why a task naming no judge server would not be judged: none connected, or several. */
  warning?: TaskWarning;
}
