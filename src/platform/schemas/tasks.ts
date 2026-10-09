/**
 * Tool input schemas for the tasks app. Imported by both the
 * in-process source (`src/platform/tasks/source.ts`) and the tool
 * handlers beside it (`src/platform/tasks/server.ts`) so the two
 * consumers always agree on the wire shape.
 *
 * Shape convention (per src/platform/AGENTS.md §1.3):
 *
 *   create: { manifest: { ...config }, body: <prompt> }
 *   update: { taskId, manifest?: patch of config (null clears), body?: <new prompt> }
 *   run / run_batch inline: { definition: { manifest?, body? } }
 *
 * One definition shape: `manifest` carries the stored task's field names and
 * `body` is the prompt that opens each run, in create, update, and an inline
 * one-off alike. Every tool names a task by `taskId` and a run by `runId`. The
 * operator-only field `source` is intentionally absent from the LLM-facing
 * schema; it lives on the stored type and is set by the runtime.
 *
 * Numeric bounds here are literals that mirror the constants the handlers
 * enforce (`src/limits.ts`, `src/platform/tasks/types.ts`): this tree is
 * codegen'd under a strict rootDir (`scripts/tsconfig.codegen-web.json`) that
 * forbids importing from outside `src/platform/schemas/`.
 */

import { type Static, type TProperties, Type } from "@sinclair/typebox";
import { clearable, StringEnum } from "./_shared.ts";
import { NotificationRouteMatch } from "./notifications.ts";

// ── Shared sub-schemas ───────────────────────────────────────────────────

const TaskIdField = Type.String({
  minLength: 1,
  description: "The task's id, as tasks__list returns it.",
});

const RunIdField = Type.String({
  minLength: 1,
  description: "The run's id, as tasks__run, tasks__runs, or tasks__upcoming return it.",
});

const Schedule = Type.Object(
  {
    type: StringEnum(["cron", "interval", "event", "once"] as const, {
      description:
        "`cron` (needs `expression`) and `interval` (needs `intervalMs`) recur. `once` (needs " +
        "`at`) fires one time, and then the task is disabled with no next run until a new `at` " +
        "re-arms it: use it for a single action at a set time instead of a cron with a fixed " +
        "date, which recurs every year. `event` (needs `match`) has no next run: the task fires " +
        "when a notification a workspace admin routed to it arrives.",
    }),
    expression: Type.Optional(
      Type.String({ description: "5-field cron expression (type=cron), e.g. `0 7 * * 1-5`." }),
    ),
    timezone: Type.Optional(
      Type.String({
        description:
          "IANA timezone the cron expression is read in (type=cron). Default: this instance's " +
          "timezone, which tasks__create and tasks__update return as `timezone`.",
      }),
    ),
    at: Type.Optional(
      Type.String({
        description:
          "When a once schedule fires (type=once): an ISO-8601 timestamp with an explicit " +
          "offset, e.g. 2026-07-01T13:12:00-07:00. Must be in the future. A once whose time " +
          "passes while the runtime is down fires on restart if it is at most an hour late, " +
          "and is recorded as skipped otherwise.",
      }),
    ),
    intervalMs: Type.Optional(
      Type.Integer({
        minimum: 60000,
        description: "Interval in ms (type=interval). Min 60000.",
      }),
    ),
    match: Type.Optional(
      Type.Object(NotificationRouteMatch.properties, {
        additionalProperties: false,
        description:
          "Which notifications this task wants (type=event). Required for an event " +
          "schedule. A workspace admin must ALSO have written a delivery route naming this " +
          "task — this narrows what arrives down that route, it does not open one.",
      }),
    ),
    debounceMs: Type.Optional(
      // Bounds mirror DEFAULT_EVENT_DEBOUNCE_MS / MAX_EVENT_DEBOUNCE_MS.
      Type.Integer({
        minimum: 1000,
        maximum: 900000,
        description:
          "How long matching notifications coalesce into one batch before the run starts, in " +
          "ms (type=event). Default 30000, max 900000. A burst becomes one run with a " +
          "list in it, not one run per item.",
      }),
    ),
    maxFiresPerHour: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 60,
        description:
          "Most runs this task may fire from events in a rolling hour (type=event). " +
          "Default 12, max 60. Exceeding it disables the task — it is what terminates a " +
          "loop in which a run's own work produces the event that fires it again.",
      }),
    ),
  },
  {
    required: ["type"],
    additionalProperties: false,
    description:
      "What fires it unattended. Omit for a task that runs only when someone runs it " +
      "(tasks__run).",
  },
);

const TokenBudget = Type.Object(
  {
    maxInputTokens: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Most input tokens this task's runs may use in total per period.",
      }),
    ),
    maxOutputTokens: Type.Optional(
      Type.Integer({
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
    additionalProperties: false,
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
  "JSON Schema each run's `input` must match (tasks__run `input`, tasks__run_batch `items`). " +
    "A run whose input does not match is refused before it starts. Omit to take any JSON input.",
);

const OutputSchemaField = jsonSchemaField(
  "JSON Schema the deliverable must match. The run is told to answer with JSON matching it; " +
    "the final output is parsed and checked, kept as the result's `structured`, and a " +
    "deliverable that does not match is assessed `fail` without a judge call.",
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
  { required: ["id", "rule", "type"], additionalProperties: false },
);

const CriteriaField = Type.Array(Criterion, {
  minItems: 1,
  maxItems: 50,
  description:
    "Acceptance criteria. After each run that leaves a deliverable, a judge server the " +
    "workspace connected answers every criterion (the deliverable, the input, and a summary " +
    "of the tool calls are sent to it), and the run is recorded pass, fail, or uncertain. " +
    "Without a connected judge server every run is uncertain (Needs review); the answer's " +
    "`warnings` say so. tasks__judges lists the judge servers.",
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
          "The connected judge server to use (tasks__judges lists them). Needed only when the " +
          "workspace has more than one.",
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
  {
    additionalProperties: false,
    description: "Which judge answers the criteria. Omit to use the one connected judge server.",
  },
);

const OnPoorResultField = StringEnum(["record", "notify", "retry_once"] as const, {
  description:
    "What a `fail` assessment does. record: nothing more. notify (default): an item in the " +
    "workspace inbox saying a run was judged poor, with its run id; it never names the task " +
    "or its criteria, since the inbox is shared and the task is private to its owner. " +
    "retry_once: run again once, with the failed criteria as guidance. Batch runs ignore it.",
});

const MaxIterationsField = Type.Integer({
  minimum: 1,
  maximum: 50,
  description:
    "Max LLM iterations per run, 1 to 50. Default 25. Runs are also held to the runtime's " +
    "per-run ceiling; create and update report the effective value.",
});

const MaxInputTokensField = Type.Integer({
  minimum: 1000,
  maximum: 1000000,
  description:
    "Input tokens one run may spend in total, summed over every model call (1000 to " +
    "1000000), counting cache reads. Before each model call the run stops with stopReason " +
    "max_input_tokens if that call's projected input would pass the cap. Omit for no " +
    "per-run cap unless the runtime sets a per-run ceiling, which also bounds a set value; " +
    "create and update report the effective value.",
});

const MaxRunDurationField = Type.Integer({
  minimum: 10000,
  maximum: 600000,
  description:
    "Max wall-clock per run (ms), 10000 to 600000. Default 120000. Runs are also held to " +
    "the runtime's per-run ceiling; create and update report the effective value.",
});

const AllowedToolsField = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
  description:
    "Tools this task's runs may use, as names or globs: `gmail__*` for a workspace " +
    "connector's tools, `my_gmail__*` for your personal one, `files__read` for one tool. A " +
    "run cannot activate or call a tool outside the list, and a run is refused before it " +
    "starts when an entry matches no tool it can reach. Only nb__search and nb__manage_tools " +
    "pass without being listed, so name any other nb__ tool a run needs (nb__use_skill for " +
    "skills, nb__read_resource for resources). Prefer a `<connector>__*` glob, since a " +
    "connector can rename its tools. Omit for every tool in the workspace; an empty list is " +
    "refused. Listing tasks__create, tasks__update, or tasks__delete is refused, and a run is " +
    "barred from tasks__run, tasks__run_batch, tasks__batch_control, and tasks__assess whatever " +
    "the list says.",
});

const SkillField = Type.String({
  minLength: 1,
  description: "A skill each run carries out, matched by name.",
});

const ModelField = Type.String({
  minLength: 1,
  description: "Model for this task's runs. Omit to use the workspace default.",
});

// The definition fields every shape shares: create's manifest, update's patch
// (each clearable), and an inline one-off's manifest.
const DefinitionFields = {
  skill: Type.Optional(SkillField),
  model: Type.Optional(ModelField),
  allowedTools: Type.Optional(AllowedToolsField),
  maxIterations: Type.Optional(MaxIterationsField),
  maxInputTokens: Type.Optional(MaxInputTokensField),
  maxRunDurationMs: Type.Optional(MaxRunDurationField),
  tokenBudget: Type.Optional(TokenBudget),
  inputSchema: Type.Optional(InputSchemaField),
  outputSchema: Type.Optional(OutputSchemaField),
  criteria: Type.Optional(CriteriaField),
  confidenceThreshold: Type.Optional(ConfidenceThresholdField),
  judge: Type.Optional(JudgeField),
  onPoorResult: Type.Optional(OnPoorResultField),
};

const BodyField = Type.String({
  description:
    "The prompt that opens every run, whatever starts it: its schedule, an event, or " +
    "someone running it. Describe the job, not tool names: a name such as " +
    "`gmail__send_email` changes with how its connector is installed (`my_` for a personal " +
    "one). List the tools in `manifest.allowedTools`, where one the run cannot reach refuses " +
    "the run. A run's `input` is given to it as data beside this prompt. Nothing delivers the " +
    "deliverable: to post or send it, say so here and allow the tool.",
});

const CreateManifest = Type.Object(
  {
    name: Type.String({
      minLength: 1,
      description: "Human-readable name. Becomes the kebab-case id, which must not already exist.",
    }),
    description: Type.Optional(Type.String({ description: "What this task does." })),
    schedule: Type.Optional(Schedule),
    enabled: Type.Optional(
      Type.Boolean({
        description:
          "Whether its schedule or events fire it. Default true. tasks__run runs it either way.",
      }),
    ),
    kind: Type.Optional(
      StringEnum(["saved", "oneoff"] as const, {
        description:
          "`saved` (default) for a task to keep and list. `oneoff` for one made to be run " +
          "once with no schedule: it is kept with its run history but left out of " +
          "tasks__list unless asked for.",
      }),
    ),
    ...DefinitionFields,
  },
  {
    required: ["name"],
    additionalProperties: false,
    description: "Task definition: identity, schedule, run-time policy.",
  },
);

// Update is the create shape as a patch, minus `name` and `kind` (a rename
// would move the id; a one-off does not become a saved task by a patch).
// `null` clears a field so its default applies again.
const UpdateManifest = Type.Object(
  {
    description: clearable(Type.String(), "New description, or null to remove it."),
    schedule: clearable(
      Schedule,
      "New schedule, or null to remove it so nothing fires it unattended. Setting a new once " +
        "`at` on a task that already ran once (or missed its time) re-arms and enables it.",
    ),
    enabled: Type.Optional(
      Type.Boolean({ description: "Whether its schedule or events fire it." }),
    ),
    skill: clearable(SkillField, "Skill each run carries out, or null for none."),
    model: clearable(ModelField, "Model for its runs, or null for the workspace default."),
    allowedTools: clearable(
      AllowedToolsField,
      "Tools its runs may use (see tasks__create), or null to allow every tool.",
    ),
    maxIterations: clearable(MaxIterationsField, "Per-run iteration cap, or null for the default."),
    maxInputTokens: clearable(MaxInputTokensField, "Per-run input-token cap, or null for none."),
    maxRunDurationMs: clearable(MaxRunDurationField, "Per-run time cap, or null for the default."),
    tokenBudget: clearable(TokenBudget, "Spending limit across runs, or null to remove it."),
    inputSchema: clearable(
      InputSchemaField,
      "New input schema, or null to remove it so runs take any input.",
    ),
    outputSchema: clearable(
      OutputSchemaField,
      "New output schema, or null to remove it so the deliverable is not checked.",
    ),
    criteria: clearable(
      CriteriaField,
      "New acceptance criteria (the whole list), or null to remove them.",
    ),
    confidenceThreshold: clearable(
      ConfidenceThresholdField,
      "New confidence threshold, or null for the default (0.7).",
    ),
    judge: clearable(
      JudgeField,
      "Which judge to use, or null to use the one connected judge server.",
    ),
    onPoorResult: clearable(
      OnPoorResultField,
      "What a fail assessment does, or null for the default (notify).",
    ),
  },
  {
    additionalProperties: false,
    description:
      "Patch of the manifest (field names as tasks__create). Omitted fields keep their " +
      "values; null clears one so its default applies.",
  },
);

/** An inline one-off's definition: create's manifest without identity or trigger. */
function inlineDefinition<T extends TProperties>(fields: T, what: string) {
  return Type.Object(
    {
      manifest: Type.Optional(
        Type.Object(fields, {
          additionalProperties: false,
          description: "As tasks__create's manifest, minus name, schedule, enabled, and kind.",
        }),
      ),
      body: Type.Optional(
        Type.String({
          description:
            "The prompt that opens each run (as tasks__create's body). Omit only with `manifest.skill`.",
        }),
      ),
    },
    {
      additionalProperties: false,
      description:
        `${what}: a \`oneoff\` task with no schedule is created from it, owned by you in this ` +
        "workspace, and kept with its runs. Give this or `taskId`, not both.",
    },
  );
}

const { onPoorResult: _batchIgnores, ...BatchDefinitionFields } = DefinitionFields;

const IdempotencyKeyField = Type.String({
  minLength: 1,
  maxLength: 256,
  description:
    "Repeat-safe key. A later call with the same key returns what the first call started " +
    "instead of starting another. With an inline definition, a repeat must give the same " +
    "definition.",
});

// ── Tool input schemas ───────────────────────────────────────────────────

export const TasksCreateInput = Type.Object(
  { manifest: CreateManifest, body: BodyField },
  { required: ["manifest", "body"], additionalProperties: false },
);
export type TasksCreateInput = Static<typeof TasksCreateInput>;

export const TasksUpdateInput = Type.Object(
  {
    taskId: TaskIdField,
    manifest: Type.Optional(UpdateManifest),
    body: Type.Optional(
      Type.String({ description: "New prompt. Omit to keep the current prompt." }),
    ),
  },
  { required: ["taskId"], additionalProperties: false },
);
export type TasksUpdateInput = Static<typeof TasksUpdateInput>;

export const TasksDeleteInput = Type.Object(
  { taskId: TaskIdField },
  { required: ["taskId"], additionalProperties: false },
);
export type TasksDeleteInput = Static<typeof TasksDeleteInput>;

export const TasksListInput = Type.Object(
  {
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
      // Default/cap mirror TASKS_LIST_DEFAULT_LIMIT / TASKS_LIST_MAX_LIMIT.
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
  },
  { additionalProperties: false },
);
export type TasksListInput = Static<typeof TasksListInput>;

export const TasksStatusInput = Type.Object(
  {
    taskId: TaskIdField,
    limit: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 50,
        description: "Recent runs to include, 0 to 50. Default 5.",
      }),
    ),
  },
  { required: ["taskId"], additionalProperties: false },
);
export type TasksStatusInput = Static<typeof TasksStatusInput>;

/** The labels an ended run reads as, as `tasks__runs` filters them. Mirror of `RunLabel`. */
const RunLabelFilter = StringEnum(
  ["Succeeded", "Poor result", "Needs review", "Failed", "Skipped", "Cancelled"] as const,
  {
    description:
      "Only runs that ended reading as this label. `Needs review` finds runs awaiting a " +
      "person's verdict. Runs still queued or running are in tasks__upcoming.",
  },
);

export const TasksRunsInput = Type.Object(
  {
    taskId: Type.Optional(Type.String({ minLength: 1, description: "Only this task's runs." })),
    label: Type.Optional(RunLabelFilter),
    verdict: Type.Optional(
      StringEnum(["pass", "fail", "uncertain", "not_assessed"] as const, {
        description:
          "Only runs with this effective verdict (a person's replaces the judge's). A run with " +
          "no deliverable has none, and never matches.",
      }),
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
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 500, description: "Max runs to return. Default 20." }),
    ),
    excludeBatchRuns: Type.Optional(
      Type.Boolean({
        description:
          "true: leave out runs that are items of a batch (read those with tasks__batch).",
      }),
    ),
  },
  { additionalProperties: false },
);
export type TasksRunsInput = Static<typeof TasksRunsInput>;

export const TasksUpcomingInput = Type.Object(
  {
    days: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 30,
        description:
          "How many days ahead to list scheduled fires. Default 7, max 30. Every enabled timed " +
          "task's next fire is listed even when it falls past the window.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type TasksUpcomingInput = Static<typeof TasksUpcomingInput>;

export const TasksStatsInput = Type.Object(
  {
    since: Type.Optional(
      Type.String({
        description: "ISO timestamp: count runs started on or after it. Default: 30 days ago.",
      }),
    ),
    taskId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Only this task (any kind). Default: every saved task.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type TasksStatsInput = Static<typeof TasksStatsInput>;

export const TasksJudgesInput = Type.Object({}, { additionalProperties: false });
export type TasksJudgesInput = Static<typeof TasksJudgesInput>;

const RunInputField = Type.Unsafe<unknown>({
  description:
    "JSON input for this run (any JSON value, at most 64 KiB serialized). Checked against " +
    "the task's inputSchema when it has one, kept on the run record, and given to the run " +
    "as data, never as instructions.",
});

export const TasksRunInput = Type.Object(
  {
    taskId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "The task to run, as tasks__list returns it. Or give `definition`.",
      }),
    ),
    definition: Type.Optional(inlineDefinition(DefinitionFields, "A one-off to run once")),
    input: Type.Optional(RunInputField),
    idempotencyKey: Type.Optional(IdempotencyKeyField),
  },
  { additionalProperties: false },
);
export type TasksRunInput = Static<typeof TasksRunInput>;

export const TasksAssessInput = Type.Object(
  {
    runId: RunIdField,
    taskId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "The run's task. Needed only for a run past the newest 1000 of its task; any other " +
          "is found by its id alone.",
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
  { required: ["runId"], additionalProperties: false },
);
export type TasksAssessInput = Static<typeof TasksAssessInput>;

export const TasksCancelInput = Type.Object(
  { runId: RunIdField },
  { required: ["runId"], additionalProperties: false },
);
export type TasksCancelInput = Static<typeof TasksCancelInput>;

export const TasksRunResultInput = Type.Object(
  {
    runId: RunIdField,
    taskId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "The run's task. Needed only for a run past the newest 1000 of its task; any other " +
          "is found by its id alone.",
      }),
    ),
  },
  { required: ["runId"], additionalProperties: false },
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
        minLength: 1,
        description: "The task every item runs, as tasks__list returns it. Or give `definition`.",
      }),
    ),
    definition: Type.Optional(
      inlineDefinition(BatchDefinitionFields, "The definition every item runs"),
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
          "runs at once. When it is spent, no new item starts and the batch pauses (resume " +
          "with a higher `budgetUsd`).",
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
            "judge doubt alone never pauses it, and nor does a task whose criteria no judge " +
            "answers. Needs a task with criteria or an outputSchema.",
        },
      ),
    ),
    idempotencyKey: Type.Optional(IdempotencyKeyField),
  },
  { required: ["items"], additionalProperties: false },
);
export type TasksRunBatchInput = Static<typeof TasksRunBatchInput>;

/** What `tasks__batch` `filter` narrows results to. `failing` is fail plus failed. */
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
          "true: include item results, a page at a time. A filter, cursor, or limit also asks for them.",
      }),
    ),
    filter: Type.Optional(BatchResultFilter),
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
  { required: ["batchId"], additionalProperties: false },
);
export type TasksBatchInput = Static<typeof TasksBatchInput>;

export const TasksBatchControlInput = Type.Object(
  {
    batchId: BatchIdField,
    action: StringEnum(["pause", "resume", "cancel", "rerun_failed"] as const, {
      description:
        "pause: no new item starts; runs still queued are taken back, runs in flight finish. " +
        "resume: start items again. cancel: stop for good, cancelling queued and running runs. " +
        "rerun_failed: run again, each as a new run, every item that failed, was skipped or " +
        "cancelled, or was judged fail (not uncertain ones: judge those with tasks__assess). " +
        "A batch paused for budget needs resume with a higher `budgetUsd` before anything " +
        "runs again.",
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
  { required: ["batchId", "action"], additionalProperties: false },
);
export type TasksBatchControlInput = Static<typeof TasksBatchControlInput>;

export const TasksBatchesInput = Type.Object(
  {
    taskId: Type.Optional(Type.String({ minLength: 1, description: "Only batches of this task." })),
    state: Type.Optional(
      StringEnum(["running", "paused", "completed", "cancelled"] as const, {
        description: "Only batches in this state.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 100, description: "Most batches. Default 20." }),
    ),
  },
  { additionalProperties: false },
);
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
 * Summary row returned per task by `handleList`. Subset of the stored `Task`
 * shape plus the schedule in words. Times are ISO-8601.
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
  /** When its schedule next fires; null when nothing will (no timed schedule, or disabled). */
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
 * A run's full deliverable: the untruncated final output, the activity log,
 * and refs to any files the run wrote in the workspace file store. Mirror of
 * `TaskRunResult` in `platform/tasks/types.ts`, less the ids the run record
 * beside it carries. A run is not a conversation.
 */
export interface TaskRunResultBody {
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
  /** Why the run failed or did not start, as its record says. */
  error?: string;
}

/**
 * `tasks__run_result`: one run by id, whatever state it is in. `status` says
 * whether it has ended; a run still queued or running is an answer, not an
 * error, so a caller polls by calling again.
 */
export type TasksRunResultOutput =
  | {
      status: "queued" | "running";
      run: TaskRunView;
      /** Queued only: 1 is next to start. */
      position?: number;
      message: string;
    }
  | {
      status: "ended";
      run: TaskRunView;
      /**
       * Every recorded run has one: a run that failed before the engine
       * returned, or never started, has an empty output and activity log and
       * its `error`. Absent only when it cannot be read.
       */
      result?: TaskRunResultBody;
    };

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
  /** The IANA timezone its schedule is read in: the schedule's own, else this instance's. */
  timezone: string;
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
  lastRunStatus?: TaskLastRunStatus;
  nextRunAt?: string;
  disabledAt?: string;
  disabledReason?: string;
  createdAt: string;
  updatedAt: string;
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
 * `allowed_tool_unavailable`: one allowedTools entry matches no tool the owner
 * can reach in this workspace; a run will fail until that changes.
 * `no_judge`, `judge_ambiguous`, `judge_not_found`: the task has criteria and
 * its workspace has no judge server it can use (none connected, several and
 * none named, or the named one is not a connected judge), so its runs are
 * `uncertain` (Needs review) until one is connected or named.
 */
export interface TaskWarning {
  code: "no_judge" | "judge_ambiguous" | "judge_not_found" | "allowed_tool_unavailable";
  message: string;
}

/**
 * `handleRun` returns one of three shapes:
 *
 *   { run; enabled; message? }               the run ended inside the
 *                                            sync-wait window (~30s), or was
 *                                            refused before it started: a
 *                                            `skipped` run whose `error` says
 *                                            why (already running or queued,
 *                                            a full queue, a spent budget).
 *
 *   { status: "dispatched"; runId; ... }     still running after the window;
 *                                            it keeps going.
 *
 *   { status: "queued"; runId; position }    every run slot was busy; it
 *                                            starts as soon as one frees.
 *
 * Read the last two with `tasks__run_result` (runId) until it says `ended`;
 * `tasks__cancel` (runId) stops them. Only an error response means nothing
 * was asked for (an unknown task, bad input, a bad definition).
 *
 * `enabled` is the task's own flag. Run now runs a disabled task, because it
 * is a deliberate act and the create form's test run depends on it; a
 * disabled task is not fired by its schedule or by events, and `message`
 * says so.
 *
 * Consumers MUST narrow before dereferencing `run.*` (`"run" in out`), never
 * `as { run: ... }`.
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
  runId: string;
  /** The run's task, when the run was found. */
  taskId?: string;
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
  message: string;
  effectiveLimits: TaskEffectiveLimits;
  /** The IANA timezone its schedule is read in: the schedule's own, else this instance's. */
  timezone: string;
  /** About the saved task, which was saved anyway. */
  warnings?: TaskWarning[];
}

export interface TasksUpdateOutput {
  task: TaskRecord;
  updated: boolean;
  message: string;
  effectiveLimits: TaskEffectiveLimits;
  /** The IANA timezone its schedule is read in: the schedule's own, else this instance's. */
  timezone: string;
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
