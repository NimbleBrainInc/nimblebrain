/**
 * The public tools' schemas: the TypeBox authoring source for the `$defs`
 * entries of every tool `contract.ts` marks public.
 *
 * `contracts/scripts/emit-contracts.ts` turns this file into the published
 * document (`schemas/contracts/tasks/v1/contract.json`), and `--check` fails
 * when the committed document differs. Nothing at runtime imports this file.
 *
 * Shape: `create` takes `{ manifest, body }`; `update` takes `{ taskId,
 * manifest?, body? }` where `manifest` is a patch and `null` clears a field; an
 * inline one-off (`run`, `run_batch`) takes `{ definition: { manifest?, body? } }`.
 * `manifest` carries the stored task's field names and `body` is the prompt.
 * Every tool names a task by `taskId`, a run by `runId` and a batch by `batchId`.
 *
 * Scope (workspace and owner) and principal are never arguments: they are
 * carried by the call's host context (CONTRACT.md §2). Every instant in an
 * output is an RFC 3339 date-time.
 *
 * Inputs are strict (`additionalProperties: false`). Outputs are open: a
 * client ignores fields it does not know.
 */

import { type Static, type TObject, type TProperties, type TSchema, Type } from "@sinclair/typebox";

/**
 * A string enum in the `{ type, enum }` form JSON Schema validators and MCP
 * clients expect, narrowed to its literals for TypeScript.
 */
export function StringEnum<T extends string>(
  values: readonly T[],
  options: { description?: string } = {},
) {
  return Type.Unsafe<T>({ type: "string", enum: [...values], ...options });
}

/** An optional field an update clears with `null`. */
function clearable<T extends TSchema>(schema: T, description: string) {
  return Type.Optional(Type.Union([schema, Type.Null()], { description }));
}

/**
 * A tool output that is one of several object shapes. MCP requires an output
 * schema whose root is `type: "object"`, so the union carries that root type.
 */
function ObjectUnion<T extends TObject[]>(members: [...T]) {
  return { ...Type.Unsafe<Static<(typeof members)[number]>>({ anyOf: members }), type: "object" };
}

/** A JSON Schema an author supplies: an open object, since its keywords are the schema language's. */
function jsonSchemaField(description: string) {
  return Type.Unsafe<Record<string, unknown>>({
    type: "object",
    properties: {},
    additionalProperties: true,
    description,
  });
}

/** Any JSON value. */
const AnyJson = (description: string) => Type.Unsafe<unknown>({ description });

const JsonObject = Type.Record(Type.String(), Type.Unknown());

// ── Shared fields ────────────────────────────────────────────────────────

const TaskIdField = Type.String({
  minLength: 1,
  description: "The task's id, as list returns it.",
});

const RunIdField = Type.String({
  minLength: 1,
  description: "The run's id, as run, runs, or upcoming return it.",
});

const BatchIdField = Type.String({
  pattern: "^batch_[a-f0-9]{12}$",
  description: "The batch's id (run_batch returns it).",
});

/** The notification levels a route matches on, lowest first. */
export const NOTIFICATION_LEVELS = ["info", "attention", "urgent"] as const;

/** Which routed notifications an event schedule wants. */
const RouteMatch = Type.Object(
  {
    source: Type.Optional(
      Type.String({
        maxLength: 200,
        description: "Exact connector server name. Omit to match every source in this workspace.",
      }),
    ),
    name: Type.Optional(
      Type.String({
        pattern: "^[a-zA-Z0-9._*-]{1,200}$",
        description:
          "Glob over the event name the server chose, e.g. `domain.*`. Omit to match every name.",
      }),
    ),
    level: Type.Optional(
      StringEnum(NOTIFICATION_LEVELS, { description: "Minimum level, not an exact match." }),
    ),
  },
  {
    additionalProperties: false,
    description: "Fires on matching notifications routed to this task by an admin.",
  },
);

// The schedule as a caller writes it: the one field present names what fires
// the task, so there is no separate `type` to get wrong. An implementation
// stores it in whatever form it likes and returns the typed form
// (`TaskScheduleSpec`) on reads.
const Schedule = Type.Object(
  {
    cron: Type.Optional(
      Type.String({
        description: "Recurs on a 5-field cron expression (`0 7 * * 1-5`), read in `timezone`.",
      }),
    ),
    at: Type.Optional(
      Type.String({ description: "Fires once at this ISO-8601 time (with an offset)." }),
    ),
    intervalMs: Type.Optional(
      Type.Integer({ minimum: 60000, description: "Recurs every this many ms. Min 60000." }),
    ),
    match: Type.Optional(RouteMatch),
    timezone: Type.Optional(
      Type.String({ description: "IANA timezone for `cron`. Default: the implementation's." }),
    ),
    debounceMs: Type.Optional(
      Type.Integer({
        minimum: 1000,
        maximum: 900000,
        description:
          "With `match`: ms that matching notifications coalesce into one run. Default 30000.",
      }),
    ),
    maxFiresPerHour: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 60,
        description: "With `match`: max runs per hour before the task disables. Default 12.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description:
      "Exactly one of `cron`, `at`, `intervalMs`, or `match`. Omit to run only on demand.",
  },
);

const TokenBudget = Type.Object(
  {
    maxInputTokens: Type.Optional(
      Type.Integer({ minimum: 1, description: "Input tokens its runs may use per period." }),
    ),
    maxOutputTokens: Type.Optional(
      Type.Integer({ minimum: 1, description: "Output tokens its runs may use per period." }),
    ),
    period: Type.Optional(
      StringEnum(["daily", "monthly"] as const, {
        description: "`daily` or `monthly` reset. Omit for a lifetime total.",
      }),
    ),
  },
  {
    additionalProperties: false,
    description: "Token limit across runs. Spent, the task is disabled.",
  },
);

const InputSchemaField = jsonSchemaField("JSON Schema each run's `input` must match.");
const OutputSchemaField = jsonSchemaField("JSON Schema the deliverable must match.");

const OnPoorResultField = StringEnum(["record", "notify", "retry_once"] as const, {
  description:
    "What a deliverable that fails the outputSchema does: record, notify (default), or retry_once.",
});

/** Run limits: the names a work spec's `limits` uses too. */
export const MaxIterationsField = Type.Integer({
  minimum: 1,
  maximum: 50,
  description: "Max model iterations per run. Default 25.",
});
export const MaxInputTokensField = Type.Integer({
  minimum: 1000,
  maximum: 1000000,
  description: "Input tokens one run may spend. Omit for no cap.",
});
export const MaxRunDurationField = Type.Integer({
  minimum: 10000,
  maximum: 600000,
  description: "Max wall-clock per run, in ms. Default 120000.",
});

export const AllowedToolsField = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
  description:
    "Tools its runs may use: one `<connector>__*` glob per connector. Omit for every tool.",
});

export const SkillsField = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
  maxItems: 5,
  description: "Skills each run is given in full, by name.",
});

export const ModelField = Type.String({
  minLength: 1,
  description: "provider:model-id or a slot name (fast). Omit for the workspace default.",
});

export const THINKING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const ThinkingEffortField = StringEnum(THINKING_EFFORTS, {
  description: "Reasoning depth for its runs. Omit for the workspace setting.",
});

// The definition fields every shape shares: create's manifest, update's patch
// (each clearable), and an inline one-off's manifest.
const DefinitionFields = {
  skills: Type.Optional(SkillsField),
  model: Type.Optional(ModelField),
  thinkingEffort: Type.Optional(ThinkingEffortField),
  allowedTools: Type.Optional(AllowedToolsField),
  maxIterations: Type.Optional(MaxIterationsField),
  maxInputTokens: Type.Optional(MaxInputTokensField),
  maxRunDurationMs: Type.Optional(MaxRunDurationField),
  tokenBudget: Type.Optional(TokenBudget),
  inputSchema: Type.Optional(InputSchemaField),
  outputSchema: Type.Optional(OutputSchemaField),
  onPoorResult: Type.Optional(OnPoorResultField),
};

const BodyField = Type.String({
  description: "The prompt every run starts from: the job, and where to deliver its result.",
});

const CreateManifest = Type.Object(
  {
    name: Type.String({ minLength: 1, description: "Human-readable name; becomes the id." }),
    description: Type.Optional(Type.String({ description: "What this task does." })),
    schedule: Type.Optional(Schedule),
    enabled: Type.Optional(
      Type.Boolean({ description: "Whether its schedule fires. Default true." }),
    ),
    kind: Type.Optional(
      StringEnum(["saved", "oneoff"] as const, {
        description:
          "`saved` (default), or `oneoff` for a task run once: hidden from list and deleted after the retention window.",
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

// Update is the create shape as a patch, minus `name` and `kind`. `null` clears
// a field so its default applies again.
const UpdateManifest = Type.Object(
  {
    description: clearable(Type.String(), "New description, or null to remove it."),
    schedule: clearable(
      Schedule,
      "null removes it. A new `at` on a task that already fired re-arms and enables it.",
    ),
    enabled: Type.Optional(
      Type.Boolean({ description: "Whether its schedule or events fire it." }),
    ),
    skills: clearable(SkillsField, "null: none."),
    model: clearable(ModelField, "null: the workspace default."),
    thinkingEffort: clearable(ThinkingEffortField, "null: the workspace setting."),
    allowedTools: clearable(AllowedToolsField, "null: every tool."),
    maxIterations: clearable(MaxIterationsField, "null: the default."),
    maxInputTokens: clearable(MaxInputTokensField, "null: no cap."),
    maxRunDurationMs: clearable(MaxRunDurationField, "null: the default."),
    tokenBudget: clearable(TokenBudget, "null: no limit."),
    inputSchema: clearable(InputSchemaField, "null: any input."),
    outputSchema: clearable(OutputSchemaField, "null: not checked."),
    onPoorResult: clearable(OnPoorResultField, "null: the default."),
  },
  {
    additionalProperties: false,
    description:
      "Patch of the manifest (field names as create). Omitted fields keep their values; null " +
      "clears one so its default applies.",
  },
);

/** An inline one-off's definition: create's manifest without identity or trigger. */
function inlineDefinition<T extends TProperties>(fields: T, what: string) {
  return Type.Object(
    {
      manifest: Type.Optional(
        Type.Object(
          {
            ...fields,
            name: Type.Optional(
              Type.String({
                minLength: 1,
                maxLength: 120,
                description:
                  "What to call it in the Runs list. Display only: it names no task and is not " +
                  "part of what an idempotencyKey compares.",
              }),
            ),
          },
          {
            additionalProperties: false,
            description:
              "As create's manifest, minus schedule, enabled, and kind; `name` is optional and only labels it.",
          },
        ),
      ),
      body: Type.Optional(
        Type.String({
          description:
            "The prompt that opens each run (as create's body). Omit only with `manifest.skills`.",
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

// ── Tool inputs ──────────────────────────────────────────────────────────

export const TasksCreateInput = Type.Object(
  { manifest: CreateManifest, body: BodyField },
  { required: ["manifest", "body"], additionalProperties: false },
);

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

export const TasksDeleteInput = Type.Object(
  { taskId: TaskIdField },
  { required: ["taskId"], additionalProperties: false },
);

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

/** The labels an ended run reads as. */
const ENDED_LABELS = [
  "Succeeded",
  "Poor result",
  "Needs review",
  "Failed",
  "Skipped",
  "Cancelled",
] as const;

/** The verdicts a run's assessment can hold. `uncertain` is reserved for judging (CONTRACT.md §13). */
const ASSESSMENT_VERDICTS = ["pass", "fail", "uncertain", "not_assessed"] as const;

export const TasksRunsInput = Type.Object(
  {
    taskId: Type.Optional(Type.String({ minLength: 1, description: "Only this task's runs." })),
    label: Type.Optional(
      StringEnum(ENDED_LABELS, {
        description:
          "Only runs that ended reading as this label. Runs still queued or running are in upcoming.",
      }),
    ),
    verdict: Type.Optional(
      StringEnum(ASSESSMENT_VERDICTS, {
        description:
          "Only runs with this verdict. A run with no deliverable has none, and never matches.",
      }),
    ),
    since: Type.Optional(
      Type.String({ description: "ISO timestamp — only runs started on or after this time." }),
    ),
    before: Type.Optional(
      Type.String({
        description:
          "ISO timestamp — only runs started before this time. Pages back through the run " +
          "history: pass the previous response's `nextBefore`, with or without `taskId`.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 500, description: "Max runs to return. Default 20." }),
    ),
    excludeBatchRuns: Type.Optional(
      Type.Boolean({
        description: "true: leave out runs that are items of a batch (read those with batch).",
      }),
    ),
  },
  { additionalProperties: false },
);

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

export const TasksRunInput = Type.Object(
  {
    taskId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "The task to run, as list returns it. Or give `definition`.",
      }),
    ),
    definition: Type.Optional(inlineDefinition(DefinitionFields, "A one-off to run once")),
    input: Type.Optional(
      AnyJson(
        "JSON input for this run (any JSON value, at most 64 KiB serialized). Checked against " +
          "the task's inputSchema when it has one, kept on the run record, and given to the run " +
          "as data, never as instructions.",
      ),
    ),
    idempotencyKey: Type.Optional(IdempotencyKeyField),
  },
  { additionalProperties: false },
);

export const TasksCancelInput = Type.Object(
  { runId: RunIdField },
  { required: ["runId"], additionalProperties: false },
);

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

export const TasksRunBatchInput = Type.Object(
  {
    taskId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "The task every item runs, as list returns it. Or give `definition`.",
      }),
    ),
    definition: Type.Optional(
      inlineDefinition(BatchDefinitionFields, "The definition every item runs"),
    ),
    items: Type.Array(AnyJson("One run's JSON input, checked against the task's inputSchema."), {
      minItems: 1,
      maxItems: 10000,
      description:
        "The inputs, one run each (at most 10,000; each at most 64 KiB serialized, 16 MiB " +
        "together). Every item is checked against the task's inputSchema first: if any fails, " +
        "the whole batch is refused (naming the first bad indices) and nothing is created.",
    }),
    concurrency: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description:
          "Most of the batch's runs at once (queued or running). The host's fair share between " +
          "workspaces applies on top.",
      }),
    ),
    budgetUsd: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        description:
          "Whole-batch ceiling in USD, checked before every model call across all of the batch's " +
          "runs at once. When what is left cannot pay for another item, no new item starts and " +
          "the batch pauses (resume with a higher `budgetUsd`). An item that costs more than " +
          "what is left can grant one run ends with errorCode exceeds_share and the batch goes " +
          "on (rerun_failed with a higher `budgetUsd` runs it again).",
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
            description: "Assessed runs before the rule applies.",
          }),
        },
        {
          required: ["minPassRate", "afterItems"],
          additionalProperties: false,
          description:
            "Pause the batch when its pass rate collapses. Needs a task with an outputSchema.",
        },
      ),
    ),
    idempotencyKey: Type.Optional(IdempotencyKeyField),
  },
  { required: ["items"], additionalProperties: false },
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
    filter: Type.Optional(
      StringEnum(
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
            "Only items in this state: a verdict (pass, fail, uncertain, not_assessed), an " +
            "execution without a deliverable (failed, skipped, cancelled), pending (not ended), " +
            "or failing (fail or failed).",
        },
      ),
    ),
    cursor: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Item index to start the page at: the previous page's `nextCursor`.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 500, description: "Items per page. Default 50." }),
    ),
    output: Type.Optional(
      StringEnum(["summary", "full"] as const, {
        description:
          "What each result row carries of its run's structured output. summary (default): its " +
          "top-level scalar fields. full: the whole structured output as `structured`; a page " +
          "then also ends when its rows reach a size budget, so follow `nextCursor`.",
      }),
    ),
  },
  { required: ["batchId"], additionalProperties: false },
);

export const TasksBatchControlInput = Type.Object(
  {
    batchId: BatchIdField,
    action: StringEnum(["pause", "resume", "cancel", "rerun_failed"] as const, {
      description:
        "pause: no new item starts; runs still queued are taken back, runs in flight finish. " +
        "resume: start items again. cancel: stop for good, cancelling queued and running runs. " +
        "rerun_failed: run again, each as a new run, every item that failed, was skipped or " +
        "cancelled, was judged fail, or ended with errorCode exceeds_share.",
    }),
    budgetUsd: Type.Optional(
      Type.Number({
        exclusiveMinimum: 0,
        description:
          "With resume or rerun_failed of a batch that is not running: the budget to run under " +
          "(more than already spent). A running batch refuses it (pause first).",
      }),
    ),
  },
  { required: ["batchId", "action"], additionalProperties: false },
);

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

// ── Records, as outputs carry them ───────────────────────────────────────

/** Why a run's agent loop stopped, as the run record keeps it (the outcome's `stopReason`). */
export const STOP_REASONS = [
  "complete",
  "max_iterations",
  "max_input_tokens",
  "spend_limit",
  "length",
  "content_filter",
  "timeout",
  "cancelled",
  "error",
  "other",
  "not_started",
] as const;

const RUN_TRIGGERS = ["scheduled", "manual", "event"] as const;

const TaskLastRunStatus = StringEnum([
  "success",
  "degraded",
  "failure",
  "timeout",
  "skipped",
] as const);

const TaskOnceDone = Type.Object({
  at: Type.String(),
  outcome: StringEnum(["ran", "missed"] as const),
});

const TaskTokenBudget = Type.Object({
  maxInputTokens: Type.Optional(Type.Number()),
  maxOutputTokens: Type.Optional(Type.Number()),
  period: Type.Optional(StringEnum(["daily", "monthly"] as const)),
});

const TaskScheduleSpec = Type.Object({
  type: StringEnum(["cron", "interval", "event", "once"] as const),
  expression: Type.Optional(Type.String()),
  timezone: Type.Optional(Type.String()),
  at: Type.Optional(Type.String()),
  intervalMs: Type.Optional(Type.Number()),
  match: Type.Optional(
    Type.Object({
      source: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      level: Type.Optional(StringEnum(NOTIFICATION_LEVELS)),
    }),
  ),
  debounceMs: Type.Optional(Type.Number()),
  maxFiresPerHour: Type.Optional(Type.Number()),
});

const OnPoorResult = StringEnum(["record", "notify", "retry_once"] as const);
const TaskSourceField = StringEnum(["user", "agent", "bundle"] as const);
const TaskKindField = StringEnum(["saved", "oneoff"] as const);

const TaskSummary = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  schedule: Type.String({
    description:
      'Human-readable trigger, e.g. "Weekdays at 8:00 AM HST", "Once at …", "Manual only".',
  }),
  scheduleType: StringEnum(["cron", "interval", "event", "once", "none"] as const),
  kind: TaskKindField,
  onceDone: Type.Optional(TaskOnceDone),
  enabled: Type.Boolean(),
  source: TaskSourceField,
  runCount: Type.Number(),
  lastRunStatus: Type.Union([TaskLastRunStatus, Type.Null()]),
  lastRunAt: Type.Union([Type.String(), Type.Null()]),
  nextRunAt: Type.Union([Type.String(), Type.Null()], {
    description: "When its schedule next fires; null when nothing will.",
  }),
  disabledAt: Type.Union([Type.String(), Type.Null()]),
  disabledReason: Type.Union([Type.String(), Type.Null()]),
  estimatedCostPerDay: Type.Number(),
  inputSchema: Type.Optional(JsonObject),
  startedVia: Type.Optional(Type.String()),
  promptPreview: Type.Optional(Type.String()),
});

/**
 * Whether a run's deliverable is acceptable. In 1.0 only the output schema
 * decides it: `pass` (it matched), `fail` (it did not), `not_assessed` (no
 * schema). `uncertain` is reserved for judging, a planned minor.
 */
const TaskRunAssessment = Type.Object({
  verdict: StringEnum(ASSESSMENT_VERDICTS),
  reason: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
  schema: Type.Optional(
    Type.Object({ valid: Type.Boolean(), errors: Type.Optional(Type.Array(Type.String())) }),
  ),
  assessedAt: Type.String(),
});

const TaskRunExecution = StringEnum([
  "queued",
  "running",
  "skipped",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
] as const);

const TaskRunLabel = StringEnum([...ENDED_LABELS, "Queued", "Running"] as const);

/** A run record with its derived execution and label. */
const TaskRunView = Type.Object({
  id: Type.String(),
  taskId: Type.String(),
  startedAt: Type.String(),
  completedAt: Type.Optional(Type.String()),
  status: StringEnum([
    "queued",
    "running",
    "success",
    "degraded",
    "failure",
    "timeout",
    "cancelled",
    "skipped",
  ] as const),
  inputTokens: Type.Number(),
  outputTokens: Type.Number(),
  toolCalls: Type.Number(),
  iterations: Type.Number(),
  error: Type.Optional(Type.String()),
  transient: Type.Optional(Type.Boolean()),
  trigger: Type.Optional(StringEnum(RUN_TRIGGERS)),
  resultPreview: Type.Optional(Type.String()),
  stopReason: Type.Optional(StringEnum(STOP_REASONS)),
  spendAccountId: Type.Optional(Type.String()),
  input: Type.Optional(Type.Unknown()),
  idempotencyKey: Type.Optional(Type.String()),
  outputSchemaValid: Type.Optional(Type.Boolean()),
  outputSchemaErrors: Type.Optional(Type.Array(Type.String())),
  unrecoveredToolFailures: Type.Optional(Type.Array(Type.String())),
  assessment: Type.Optional(TaskRunAssessment),
  retryOf: Type.Optional(Type.String()),
  batchId: Type.Optional(Type.String()),
  batchIndex: Type.Optional(Type.Number()),
  costUsd: Type.Optional(Type.Number()),
  unpricedCalls: Type.Optional(Type.Integer({ minimum: 1 })),
  execution: TaskRunExecution,
  label: TaskRunLabel,
});

/** One tool call of a run's activity log: what the outcome reported, never its input or output. */
const RunToolCallRecord = Type.Object({
  name: Type.String(),
  ok: Type.Boolean(),
  errorReason: Type.Optional(Type.String()),
  held: Type.Optional(Type.Literal(true)),
  ms: Type.Number(),
});

/** A file a run wrote, as the host reported it. */
const RunFileRefRecord = Type.Object({
  uri: Type.String({ description: "Opaque: the host's reference to the file." }),
  name: Type.Optional(Type.String()),
});

const SkillDelivered = Type.Object({
  name: Type.String(),
  loadedBy: StringEnum(["declared", "before_call", "tool_use", "activation"] as const),
  status: Type.Optional(StringEnum(["fetch_failed", "capped", "renamed_unheld"] as const)),
});

/** A run's whole deliverable and what the host reported of it. */
const TaskRunResultBody = Type.Object({
  completedAt: Type.String(),
  output: Type.String(),
  activityLog: Type.Array(RunToolCallRecord),
  outputFiles: Type.Array(RunFileRefRecord),
  usage: Type.Object({
    inputTokens: Type.Number(),
    outputTokens: Type.Number(),
    iterations: Type.Number(),
  }),
  stopReason: Type.Optional(StringEnum(STOP_REASONS)),
  structured: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
  skillsDelivered: Type.Optional(Type.Array(SkillDelivered)),
});

const TaskStatusDetail = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  prompt: Type.String(),
  schedule: Type.Optional(TaskScheduleSpec),
  kind: Type.Optional(TaskKindField),
  onceDone: Type.Optional(TaskOnceDone),
  scheduleHuman: Type.String(),
  timezone: Type.String(),
  enabled: Type.Boolean(),
  source: TaskSourceField,
  ownerId: Type.Optional(Type.String()),
  workspaceId: Type.Optional(Type.String()),
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  thinkingEffort: Type.Optional(Type.Union([StringEnum(THINKING_EFFORTS), Type.Null()])),
  skills: Type.Optional(Type.Array(Type.String())),
  allowedTools: Type.Optional(Type.Array(Type.String())),
  inputSchema: Type.Optional(JsonObject),
  outputSchema: Type.Optional(JsonObject),
  onPoorResult: Type.Optional(OnPoorResult),
  maxIterations: Type.Optional(Type.Number()),
  maxInputTokens: Type.Optional(Type.Number()),
  maxRunDurationMs: Type.Optional(Type.Number()),
  runCount: Type.Number(),
  consecutiveErrors: Type.Number(),
  cumulativeInputTokens: Type.Number(),
  cumulativeOutputTokens: Type.Number(),
  tokenBudget: Type.Union([TaskTokenBudget, Type.Null()]),
  budgetResetAt: Type.Union([Type.String(), Type.Null()]),
  lastRunAt: Type.Optional(Type.String()),
  lastRunStatus: Type.Optional(TaskLastRunStatus),
  nextRunAt: Type.Optional(Type.String()),
  disabledAt: Type.Optional(Type.String()),
  disabledReason: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  estimatedCostPerRun: Type.Number(),
  estimatedCostPerDay: Type.Number(),
  estimatedCostPerMonth: Type.Number(),
});

/** A stored task, as create and update return it. Never carries its run grant. */
const TaskRecord = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  prompt: Type.String(),
  schedule: Type.Optional(TaskScheduleSpec),
  kind: Type.Optional(TaskKindField),
  onceDone: Type.Optional(TaskOnceDone),
  skills: Type.Optional(Type.Array(Type.String())),
  allowedTools: Type.Optional(Type.Array(Type.String())),
  inputSchema: Type.Optional(JsonObject),
  outputSchema: Type.Optional(JsonObject),
  onPoorResult: Type.Optional(OnPoorResult),
  maxIterations: Type.Optional(Type.Number()),
  maxInputTokens: Type.Optional(Type.Number()),
  maxRunDurationMs: Type.Optional(Type.Number()),
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  thinkingEffort: Type.Optional(Type.Union([StringEnum(THINKING_EFFORTS), Type.Null()])),
  enabled: Type.Boolean(),
  ownerId: Type.Optional(Type.String()),
  workspaceId: Type.Optional(Type.String()),
  source: TaskSourceField,
  createdAt: Type.String(),
  updatedAt: Type.String(),
  lastRunAt: Type.Optional(Type.String()),
  lastRunStatus: Type.Optional(TaskLastRunStatus),
  nextRunAt: Type.Optional(Type.String()),
  runCount: Type.Number(),
  consecutiveErrors: Type.Number(),
  disabledAt: Type.Optional(Type.String()),
  disabledReason: Type.Optional(Type.String()),
  cumulativeInputTokens: Type.Number(),
  cumulativeOutputTokens: Type.Number(),
  tokenBudget: Type.Optional(TaskTokenBudget),
  budgetResetAt: Type.Optional(Type.String()),
});

const ScheduleTimezone = Type.String({
  description:
    "The IANA timezone its schedule is read in: the schedule's own, else the implementation's.",
});

const TaskBatchCounts = Type.Object({
  pending: Type.Number(),
  queued: Type.Number(),
  running: Type.Number(),
  pass: Type.Number(),
  fail: Type.Number(),
  uncertain: Type.Number(),
  not_assessed: Type.Number(),
  failed: Type.Number(),
  skipped: Type.Number(),
  cancelled: Type.Number(),
});

/** A batch, with the figures derived on read. */
const TaskBatchView = Type.Object({
  id: Type.String(),
  taskId: Type.String(),
  workspaceId: Type.String(),
  ownerId: Type.String(),
  items: Type.Number(),
  concurrency: Type.Number(),
  sharing: Type.Optional(Type.Number()),
  budgetUsd: Type.Optional(Type.Number()),
  stopWhen: Type.Optional(Type.Object({ minPassRate: Type.Number(), afterItems: Type.Number() })),
  stopRuleDisarmed: Type.Optional(Type.Boolean()),
  state: StringEnum(["running", "paused", "completed", "cancelled"] as const),
  pause: Type.Optional(
    Type.Object({
      reason: StringEnum(["manual", "budget", "pass_rate", "unavailable"] as const),
      message: Type.String(),
      at: Type.String(),
    }),
  ),
  counts: TaskBatchCounts,
  costUsd: Type.Number(),
  idempotencyKey: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  startedVia: Type.Optional(Type.String()),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  completedAt: Type.Optional(Type.String()),
  createdBy: Type.String(),
  done: Type.Number(),
  passRate: Type.Union([Type.Number(), Type.Null()]),
});

const TaskBatchItemView = Type.Object({
  index: Type.Number(),
  inputSummary: Type.String(),
  state: StringEnum(["pending", "queued", "running", "done"] as const),
  runId: Type.Optional(Type.String()),
  previousRunIds: Type.Optional(Type.Array(Type.String())),
  execution: Type.Optional(TaskRunExecution),
  verdict: Type.Optional(StringEnum(ASSESSMENT_VERDICTS)),
  label: Type.Optional(TaskRunLabel),
  costUsd: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
  errorCode: Type.Optional(StringEnum(["exceeds_share"] as const)),
  output: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    ),
  ),
  structured: Type.Optional(Type.Unknown()),
  structuredOmitted: Type.Optional(Type.Boolean()),
});

// ── Tool outputs ─────────────────────────────────────────────────────────

export const TasksCreateOutput = Type.Object({
  task: TaskRecord,
  message: Type.String(),
  timezone: ScheduleTimezone,
});

export const TasksUpdateOutput = Type.Object({
  task: TaskRecord,
  updated: Type.Boolean(),
  message: Type.String(),
  timezone: ScheduleTimezone,
});

export const TasksDeleteOutput = Type.Object({
  deleted: Type.Boolean(),
  id: Type.String(),
  message: Type.String(),
});

export const TasksListOutput = Type.Object({
  tasks: Type.Array(TaskSummary),
  total: Type.Integer(),
  returned: Type.Integer(),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
  truncated: Type.Optional(Type.String()),
});

export const TasksStatusOutput = Type.Object({
  task: TaskStatusDetail,
  recentRuns: Type.Array(TaskRunView),
});

export const TasksRunsOutput = Type.Object({
  runs: Type.Array(TaskRunView),
  total: Type.Integer(),
  nextBefore: Type.Optional(Type.String()),
});

/**
 * `run` answers at once: the run is asked for, and its id is the handle. Its
 * state is read with `run_result`. `existing` is true when an earlier call
 * with the same idempotencyKey asked for this run.
 */
export const TasksRunOutput = Type.Object({
  status: Type.Literal("queued"),
  taskId: Type.String(),
  runId: Type.String(),
  enabled: Type.Boolean(),
  existing: Type.Optional(Type.Boolean()),
  message: Type.String(),
});

export const TasksRunResultOutput = ObjectUnion([
  Type.Object({
    status: StringEnum(["queued", "running"] as const),
    run: TaskRunView,
    message: Type.String(),
  }),
  Type.Object({
    status: Type.Literal("ended"),
    run: TaskRunView,
    result: Type.Optional(TaskRunResultBody),
  }),
]);

export const TasksCancelOutput = Type.Object({
  cancelled: Type.Boolean(),
  runId: Type.String(),
  taskId: Type.Optional(Type.String()),
  message: Type.String(),
});

export const TasksRunBatchOutput = Type.Object({
  batch: TaskBatchView,
  existing: Type.Boolean(),
  message: Type.String(),
});

export const TasksBatchOutput = Type.Object({
  batch: TaskBatchView,
  results: Type.Optional(Type.Array(TaskBatchItemView)),
  nextCursor: Type.Optional(Type.Integer()),
});

export const TasksBatchControlOutput = Type.Object({
  batch: TaskBatchView,
  message: Type.String(),
  affected: Type.Integer(),
});

export const TasksBatchesOutput = Type.Object({
  batches: Type.Array(TaskBatchView),
});

const TaskUpcomingRun = Type.Object({
  taskId: Type.String(),
  taskName: Type.Optional(Type.String()),
  runId: Type.Optional(Type.String()),
  state: StringEnum(["running", "queued"] as const),
  startedAt: Type.Optional(Type.String()),
  queuedAt: Type.Optional(Type.String()),
  trigger: Type.Optional(StringEnum(RUN_TRIGGERS)),
  batchId: Type.Optional(Type.String()),
  batchIndex: Type.Optional(Type.Number()),
});

export const TasksUpcomingOutput = Type.Object({
  running: Type.Array(TaskUpcomingRun),
  queued: Type.Array(TaskUpcomingRun),
  days: Type.Number(),
  windowEnd: Type.String(),
  scheduled: Type.Array(
    Type.Object({
      taskId: Type.String(),
      taskName: Type.String(),
      at: Type.String(),
      schedule: Type.String(),
      scheduleType: StringEnum(["cron", "interval", "once"] as const),
      beyondWindow: Type.Optional(Type.Boolean()),
    }),
  ),
  frequent: Type.Array(
    Type.Object({
      taskId: Type.String(),
      taskName: Type.String(),
      schedule: Type.String(),
      scheduleType: StringEnum(["cron", "interval"] as const),
      count: Type.Integer(),
      countCapped: Type.Optional(Type.Boolean()),
      first: Type.String(),
      last: Type.Optional(Type.String()),
    }),
  ),
  events: Type.Array(
    Type.Object({
      taskId: Type.String(),
      taskName: Type.String(),
      schedule: Type.String(),
      enabled: Type.Boolean(),
      maxFiresPerHour: Type.Number(),
      firesLastHour: Type.Integer(),
    }),
  ),
});

export const TasksStatsOutput = Type.Object({
  since: Type.String(),
  tasks: Type.Array(
    Type.Object({
      taskId: Type.String(),
      runs: Type.Integer(),
      pass: Type.Integer(),
      fail: Type.Integer(),
      uncertain: Type.Integer(),
      passRate: Type.Union([Type.Number(), Type.Null()]),
      costUsd: Type.Number(),
      lastRun: Type.Optional(
        Type.Object({ id: Type.String(), startedAt: Type.String(), label: TaskRunLabel }),
      ),
      recent: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String(),
            startedAt: Type.String(),
            label: TaskRunLabel,
            error: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),
  ),
});

/** Every public tool: name → input and output schema. */
export const PUBLIC_SCHEMAS = {
  create: { input: TasksCreateInput, output: TasksCreateOutput },
  update: { input: TasksUpdateInput, output: TasksUpdateOutput },
  delete: { input: TasksDeleteInput, output: TasksDeleteOutput },
  list: { input: TasksListInput, output: TasksListOutput },
  status: { input: TasksStatusInput, output: TasksStatusOutput },
  run: { input: TasksRunInput, output: TasksRunOutput },
  run_result: { input: TasksRunResultInput, output: TasksRunResultOutput },
  runs: { input: TasksRunsInput, output: TasksRunsOutput },
  cancel: { input: TasksCancelInput, output: TasksCancelOutput },
  upcoming: { input: TasksUpcomingInput, output: TasksUpcomingOutput },
  stats: { input: TasksStatsInput, output: TasksStatsOutput },
  run_batch: { input: TasksRunBatchInput, output: TasksRunBatchOutput },
  batch: { input: TasksBatchInput, output: TasksBatchOutput },
  batches: { input: TasksBatchesInput, output: TasksBatchesOutput },
  batch_control: { input: TasksBatchControlInput, output: TasksBatchControlOutput },
} as const satisfies Record<string, { input: TSchema; output: TSchema }>;
