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
 * Every tool names a task by `taskId`, a run by `runId` and a batch by `batchId`.
 *
 * Scope and principal are never arguments: they are carried by the call's host
 * context (CONTRACT.md §2).
 *
 * Inputs are strict (`additionalProperties: false`). Outputs are open, and
 * require only a core every implementation computes from the contract
 * (CONTRACT.md §4); every other output field is optional.
 */

import { type Static, type TSchema, Type } from "@sinclair/typebox";

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

/** Exactly one of several schemas (`oneOf`), typed as their union. */
export function OneOf<T extends TSchema[]>(
  members: [...T],
  options: { description?: string } = {},
) {
  return Type.Unsafe<Static<T[number]>>({ oneOf: members, ...options });
}

/** An optional field an update clears with `null`. */
function clearable<T extends TSchema>(schema: T, description: string) {
  return Type.Optional(Type.Union([schema, Type.Null()], { description }));
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

/** An ISO-8601 date-time with an offset. */
const DateTime = (description?: string) =>
  Type.String({ format: "date-time", ...(description ? { description } : {}) });

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
  minLength: 1,
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
        description: "Glob over the event name the server chose. Omit to match every name.",
      }),
    ),
    level: Type.Optional(
      StringEnum(NOTIFICATION_LEVELS, { description: "Minimum level, not an exact match." }),
    ),
  },
  { additionalProperties: false },
);

/**
 * The schedule, one shape on input and output: the one key present names what
 * fires the task. Closed on input, open on output.
 */
function schedule(closed: boolean, description: string) {
  const options = closed ? { additionalProperties: false } : {};
  return OneOf(
    [
      Type.Object(
        {
          cron: Type.String({
            minLength: 1,
            description: "Recurs on a 5-field cron expression (`0 7 * * 1-5`), read in `timezone`.",
          }),
          timezone: Type.String({
            minLength: 1,
            description: "The IANA timezone the cron is read in. Required with `cron`.",
          }),
        },
        options,
      ),
      Type.Object({ at: DateTime("Fires once at this instant.") }, options),
      Type.Object(
        {
          intervalMs: Type.Integer({
            minimum: 60000,
            description: "Recurs every this many ms. Min 60000.",
          }),
        },
        options,
      ),
      Type.Object(
        {
          match: RouteMatch,
          debounceMs: Type.Optional(
            Type.Integer({
              minimum: 1000,
              maximum: 900000,
              description: "ms that matching notifications coalesce into one run. Default 30000.",
            }),
          ),
          maxFiresPerHour: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 60,
              description: "Max runs per hour before the task disables. Default 12.",
            }),
          ),
        },
        options,
      ),
    ],
    { description },
  );
}

const ScheduleInput = schedule(
  true,
  "Exactly one of `cron` (with `timezone`), `at`, `intervalMs`, or `match` (fires on routed " +
    "notifications). Omit to run only on demand.",
);
const ScheduleOutput = schedule(false, "What fires the task, as it was written.");

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
        description: "A UTC calendar day or month. Omit for a lifetime total.",
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

const AllowedToolsField = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
  description:
    "Tool name globs its runs are narrowed to, matched by the host. Omit for every tool.",
});

const SkillsField = Type.Array(Type.String({ minLength: 1 }), {
  minItems: 1,
  maxItems: 5,
  description: "Skills each run is given in full, by name, matched by the host.",
});

const ModelField = Type.String({
  minLength: 1,
  description: "provider:model-id or a slot name (fast). Omit for the workspace default.",
});

export const THINKING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const ThinkingEffortField = StringEnum(THINKING_EFFORTS, {
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
};

const CreateManifest = Type.Object(
  {
    name: Type.String({ minLength: 1, description: "Human-readable name; becomes the id." }),
    description: Type.Optional(Type.String({ description: "What this task does." })),
    schedule: Type.Optional(ScheduleInput),
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

const UpdateManifest = Type.Object(
  {
    description: clearable(Type.String(), "New description, or null to remove it."),
    schedule: clearable(
      ScheduleInput,
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
  },
  {
    additionalProperties: false,
    description:
      "Patch of the manifest (field names as create). Omitted fields keep their values; null " +
      "clears one so its default applies.",
  },
);

/** An inline one-off's definition: create's manifest without identity or trigger. */
function inlineDefinition(what: string) {
  return Type.Object(
    {
      manifest: Type.Optional(
        Type.Object(
          {
            ...DefinitionFields,
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
  {
    manifest: CreateManifest,
    body: Type.String({
      description: "The prompt every run starts from: the job, and where to deliver its result.",
    }),
  },
  { additionalProperties: false },
);

export const TasksUpdateInput = Type.Object(
  {
    taskId: TaskIdField,
    manifest: Type.Optional(UpdateManifest),
    body: Type.Optional(
      Type.String({ description: "New prompt. Omit to keep the current prompt." }),
    ),
  },
  { additionalProperties: false },
);

export const TasksDeleteInput = Type.Object(
  { taskId: TaskIdField },
  { additionalProperties: false },
);

export const TasksListInput = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean({ description: "Filter by enabled status." })),
    kind: Type.Optional(
      StringEnum(["saved", "oneoff", "all"] as const, {
        description: "Which kind to list. Default `saved`; `oneoff` or `all` to include one-offs.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 500,
        description: "Max tasks to return. Default 100, max 500.",
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
  { additionalProperties: false },
);

/** How a run ended, or that it has not (ADR-0045). The one status vocabulary. */
const EXECUTIONS = [
  "queued",
  "running",
  "skipped",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
] as const;

/** The executions of a run that has ended. */
const ENDED_EXECUTIONS = ["skipped", "completed", "incomplete", "failed", "cancelled"] as const;

/** The labels an ended run reads as. */
const ENDED_LABELS = [
  "Succeeded",
  "Poor result",
  "Needs review",
  "Failed",
  "Skipped",
  "Cancelled",
] as const;

/** The verdicts a run's assessment can hold. `uncertain` is reserved for judging (CONTRACT.md §15). */
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
    since: Type.Optional(DateTime("Only runs started at or after this instant.")),
    before: Type.Optional(
      DateTime(
        "Only runs started before this instant. Pass the previous response's `nextBefore` to " +
          "page back through the history, with or without `taskId`.",
      ),
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
      DateTime("Count runs started at or after this instant. Default: 30 days ago."),
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
    definition: Type.Optional(inlineDefinition("A one-off to run once")),
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

export const TasksCancelInput = Type.Object({ runId: RunIdField }, { additionalProperties: false });

export const TasksRunResultInput = Type.Object(
  { runId: RunIdField },
  { additionalProperties: false },
);

export const TasksRunBatchInput = Type.Object(
  {
    taskId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "The task every item runs, as list returns it. Or give `definition`.",
      }),
    ),
    definition: Type.Optional(inlineDefinition("The definition every item runs")),
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
          additionalProperties: false,
          description:
            "Pause the batch when its pass rate collapses. Needs a task with an outputSchema.",
        },
      ),
    ),
    idempotencyKey: Type.Optional(IdempotencyKeyField),
  },
  { additionalProperties: false },
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
  { additionalProperties: false },
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
  { additionalProperties: false },
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
//
// Outputs are open, and each requires only its core (CONTRACT.md §4).

const RUN_TRIGGERS = ["scheduled", "manual", "event"] as const;

const TaskRunLabel = StringEnum([...ENDED_LABELS, "Queued", "Running"] as const);
const TaskRunExecution = StringEnum(EXECUTIONS);

const TaskTokenBudget = Type.Object({
  maxInputTokens: Type.Optional(Type.Number()),
  maxOutputTokens: Type.Optional(Type.Number()),
  period: Type.Optional(StringEnum(["daily", "monthly"] as const)),
});

/** A stored task, as create, update and status return it. Never carries its run grant. */
const TaskRecord = Type.Object({
  id: Type.String(),
  name: Type.String(),
  enabled: Type.Boolean(),
  prompt: Type.String(),
  description: Type.Optional(Type.String()),
  schedule: Type.Optional(ScheduleOutput),
  scheduleHuman: Type.Optional(
    Type.String({ description: 'The schedule in words, e.g. "Weekdays at 8:00 AM HST".' }),
  ),
  kind: Type.Optional(StringEnum(["saved", "oneoff"] as const)),
  onceDone: Type.Optional(
    Type.Object({ at: Type.String(), outcome: StringEnum(["ran", "missed"] as const) }),
  ),
  skills: Type.Optional(Type.Array(Type.String())),
  allowedTools: Type.Optional(Type.Array(Type.String())),
  inputSchema: Type.Optional(JsonObject),
  outputSchema: Type.Optional(JsonObject),
  maxIterations: Type.Optional(Type.Number()),
  maxInputTokens: Type.Optional(Type.Number()),
  maxRunDurationMs: Type.Optional(Type.Number()),
  model: Type.Optional(Type.String()),
  thinkingEffort: Type.Optional(StringEnum(THINKING_EFFORTS)),
  tokenBudget: Type.Optional(TaskTokenBudget),
  budgetResetAt: Type.Optional(Type.String()),
  cumulativeInputTokens: Type.Optional(Type.Number()),
  cumulativeOutputTokens: Type.Optional(Type.Number()),
  ownerId: Type.Optional(Type.String()),
  workspaceId: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.String()),
  updatedAt: Type.Optional(Type.String()),
  runCount: Type.Optional(Type.Number()),
  consecutiveErrors: Type.Optional(Type.Number()),
  lastRunAt: Type.Optional(Type.String()),
  lastRunLabel: Type.Optional(TaskRunLabel),
  nextRunAt: Type.Optional(Type.String()),
  disabledAt: Type.Optional(Type.String()),
  disabledReason: Type.Optional(Type.String()),
});

/** One row of list. */
const TaskSummary = Type.Object({
  id: Type.String(),
  name: Type.String(),
  enabled: Type.Boolean(),
  description: Type.Optional(Type.String()),
  scheduleHuman: Type.Optional(Type.String()),
  scheduleType: Type.Optional(StringEnum(["cron", "interval", "event", "once", "none"] as const)),
  kind: Type.Optional(StringEnum(["saved", "oneoff"] as const)),
  onceDone: Type.Optional(
    Type.Object({ at: Type.String(), outcome: StringEnum(["ran", "missed"] as const) }),
  ),
  runCount: Type.Optional(Type.Number()),
  lastRunAt: Type.Optional(Type.String()),
  lastRunLabel: Type.Optional(TaskRunLabel),
  nextRunAt: Type.Optional(Type.String()),
  disabledAt: Type.Optional(Type.String()),
  disabledReason: Type.Optional(Type.String()),
  inputSchema: Type.Optional(JsonObject),
  promptPreview: Type.Optional(Type.String()),
});

/**
 * Whether a run's deliverable is acceptable. In 1.0 the output schema alone
 * decides it: `pass`, `fail`, or `not_assessed` (no schema). `uncertain` is
 * reserved for judging.
 */
const TaskRunAssessment = Type.Object({
  verdict: StringEnum(ASSESSMENT_VERDICTS),
  reason: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
  schema: Type.Optional(
    Type.Object({ valid: Type.Boolean(), errors: Type.Optional(Type.Array(Type.String())) }),
  ),
  assessedAt: Type.Optional(Type.String()),
});

/**
 * A run, as every run surface returns it. `startedAt` is present once the run
 * has started or ended without starting; `completedAt` once it has ended.
 */
const TaskRunView = Type.Object(
  {
    id: Type.String(),
    taskId: Type.String(),
    execution: TaskRunExecution,
    label: TaskRunLabel,
    startedAt: Type.Optional(Type.String()),
    completedAt: Type.Optional(Type.String()),
    trigger: Type.Optional(StringEnum(RUN_TRIGGERS)),
    error: Type.Optional(Type.String()),
    transient: Type.Optional(Type.Boolean()),
    resultPreview: Type.Optional(Type.String()),
    assessment: Type.Optional(TaskRunAssessment),
    unrecoveredToolFailures: Type.Optional(Type.Array(Type.String())),
    inputTokens: Type.Optional(Type.Number()),
    outputTokens: Type.Optional(Type.Number()),
    iterations: Type.Optional(Type.Number()),
    toolCalls: Type.Optional(Type.Number({ description: "How many tool calls it made." })),
    costUsd: Type.Optional(Type.Number()),
    unpricedCalls: Type.Optional(Type.Integer({ minimum: 1 })),
    spendAccountId: Type.Optional(Type.String()),
    input: Type.Optional(Type.Unknown()),
    idempotencyKey: Type.Optional(Type.String()),
    retryOf: Type.Optional(Type.String()),
    batchId: Type.Optional(Type.String()),
    batchIndex: Type.Optional(Type.Number()),
  },
  {
    allOf: [
      {
        if: { properties: { execution: { not: { const: "queued" } } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then keyword.
        then: { required: ["startedAt"] },
      },
      {
        if: { properties: { execution: { enum: [...ENDED_EXECUTIONS] } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then keyword.
        then: { required: ["completedAt"] },
      },
    ],
  },
);

/** A run's whole deliverable and what the host reported of it. */
const TaskRunResultBody = Type.Object({
  completedAt: Type.String(),
  output: Type.String(),
  structured: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
  activityLog: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        ok: Type.Boolean(),
        errorReason: Type.Optional(Type.String()),
        ms: Type.Optional(Type.Number()),
      }),
      { description: "Each tool call the run made, in call order; never its input or output." },
    ),
  ),
  outputFiles: Type.Optional(
    Type.Array(Type.Object({ uri: Type.String(), name: Type.Optional(Type.String()) })),
  ),
  usage: Type.Optional(
    Type.Object({
      inputTokens: Type.Optional(Type.Number()),
      outputTokens: Type.Optional(Type.Number()),
      iterations: Type.Optional(Type.Number()),
    }),
  ),
  stopReason: Type.Optional(Type.String()),
  skillsDelivered: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        loadedBy: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
      }),
    ),
  ),
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

const TaskBatchView = Type.Object({
  id: Type.String(),
  taskId: Type.String(),
  state: StringEnum(["running", "paused", "completed", "cancelled"] as const),
  counts: TaskBatchCounts,
  name: Type.Optional(Type.String()),
  items: Type.Optional(Type.Number()),
  done: Type.Optional(Type.Number({ description: "Items with an outcome." })),
  passRate: Type.Optional(
    Type.Number({ description: "pass / (pass + fail); absent before either." }),
  ),
  concurrency: Type.Optional(Type.Number()),
  sharing: Type.Optional(Type.Number()),
  budgetUsd: Type.Optional(Type.Number()),
  costUsd: Type.Optional(Type.Number()),
  stopWhen: Type.Optional(Type.Object({ minPassRate: Type.Number(), afterItems: Type.Number() })),
  stopRuleDisarmed: Type.Optional(Type.Boolean()),
  pause: Type.Optional(
    Type.Object({
      reason: StringEnum(["manual", "budget", "pass_rate", "unavailable"] as const),
      message: Type.Optional(Type.String()),
      at: Type.Optional(Type.String()),
    }),
  ),
  idempotencyKey: Type.Optional(Type.String()),
  ownerId: Type.Optional(Type.String()),
  workspaceId: Type.Optional(Type.String()),
  createdAt: Type.Optional(Type.String()),
  updatedAt: Type.Optional(Type.String()),
  completedAt: Type.Optional(Type.String()),
});

const TaskBatchItemView = Type.Object({
  index: Type.Number(),
  state: StringEnum(["pending", "queued", "running", "done"] as const),
  runId: Type.Optional(Type.String()),
  previousRunIds: Type.Optional(Type.Array(Type.String())),
  execution: Type.Optional(TaskRunExecution),
  verdict: Type.Optional(StringEnum(ASSESSMENT_VERDICTS)),
  label: Type.Optional(TaskRunLabel),
  inputSummary: Type.Optional(Type.String()),
  costUsd: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
  errorCode: Type.Optional(
    StringEnum(["exceeds_share"] as const, {
      description:
        "A run of the item with what was left of the batch's budget to itself could not pay for " +
        "it (its outcome's spendStop was exhausted), so it was settled rather than run again.",
    }),
  ),
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

const Message = Type.Optional(Type.String({ description: "A sentence for the reader." }));

export const TasksCreateOutput = Type.Object({ task: TaskRecord, message: Message });

export const TasksUpdateOutput = Type.Object({
  task: TaskRecord,
  updated: Type.Optional(Type.Boolean()),
  message: Message,
});

export const TasksDeleteOutput = Type.Object({
  deleted: Type.Boolean(),
  id: Type.String(),
  message: Message,
});

export const TasksListOutput = Type.Object({
  tasks: Type.Array(TaskSummary),
  nextCursor: Type.Union([Type.String(), Type.Null()], {
    description: "Pass as `cursor` for the next page; null on the last.",
  }),
  total: Type.Optional(Type.Integer({ description: "Every match, before the page cap." })),
  hasMore: Type.Optional(Type.Boolean()),
  truncated: Type.Optional(Type.String()),
});

export const TasksStatusOutput = Type.Object({
  task: TaskRecord,
  recentRuns: Type.Array(TaskRunView),
});

export const TasksRunsOutput = Type.Object({
  runs: Type.Array(TaskRunView),
  nextBefore: Type.Optional(Type.String()),
  total: Type.Optional(Type.Integer()),
});

/**
 * `run` answers at once: the run is asked for, and its id is the handle. Its
 * state is read with `run_result`.
 */
export const TasksRunOutput = Type.Object({
  runId: Type.String(),
  taskId: Type.String(),
  execution: Type.Literal("queued"),
  existing: Type.Optional(
    Type.Boolean({
      description: "An earlier call with the same idempotencyKey asked for this run.",
    }),
  ),
  enabled: Type.Optional(Type.Boolean()),
  message: Message,
});

/**
 * One run by id, whatever state it is in: `run.execution` says whether it has
 * ended. A run still queued or running is an answer, not an error. `result` is
 * present once it has ended and its result can be read.
 */
export const TasksRunResultOutput = Type.Object({
  run: TaskRunView,
  result: Type.Optional(TaskRunResultBody),
  message: Message,
});

export const TasksCancelOutput = Type.Object({
  cancelled: Type.Boolean(),
  runId: Type.String(),
  taskId: Type.Optional(Type.String()),
  message: Message,
});

export const TasksRunBatchOutput = Type.Object({
  batch: TaskBatchView,
  existing: Type.Optional(Type.Boolean()),
  message: Message,
});

export const TasksBatchOutput = Type.Object({
  batch: TaskBatchView,
  results: Type.Optional(Type.Array(TaskBatchItemView)),
  nextCursor: Type.Optional(Type.Integer()),
});

export const TasksBatchControlOutput = Type.Object({
  batch: TaskBatchView,
  affected: Type.Optional(Type.Integer({ description: "Items the action touched." })),
  message: Message,
});

export const TasksBatchesOutput = Type.Object({ batches: Type.Array(TaskBatchView) });

export const TasksUpcomingOutput = Type.Object({
  running: Type.Array(
    Type.Object({
      taskId: Type.String(),
      runId: Type.String(),
      taskName: Type.Optional(Type.String()),
      startedAt: Type.Optional(Type.String()),
      trigger: Type.Optional(StringEnum(RUN_TRIGGERS)),
      batchId: Type.Optional(Type.String()),
      batchIndex: Type.Optional(Type.Number()),
    }),
  ),
  queued: Type.Array(
    Type.Object({
      taskId: Type.String(),
      runId: Type.Optional(Type.String({ description: "Absent until the run has an id." })),
      taskName: Type.Optional(Type.String()),
      queuedAt: Type.Optional(Type.String()),
      trigger: Type.Optional(StringEnum(RUN_TRIGGERS)),
      batchId: Type.Optional(Type.String()),
      batchIndex: Type.Optional(Type.Number()),
    }),
  ),
  scheduled: Type.Array(
    Type.Object({
      taskId: Type.String(),
      at: Type.String(),
      taskName: Type.Optional(Type.String()),
      scheduleHuman: Type.Optional(Type.String()),
      scheduleType: Type.Optional(StringEnum(["cron", "interval", "once"] as const)),
      beyondWindow: Type.Optional(Type.Boolean()),
    }),
  ),
  days: Type.Optional(Type.Number()),
  windowEnd: Type.Optional(Type.String()),
  frequent: Type.Optional(
    Type.Array(
      Type.Object({
        taskId: Type.String(),
        count: Type.Integer(),
        first: Type.String(),
        taskName: Type.Optional(Type.String()),
        scheduleHuman: Type.Optional(Type.String()),
        scheduleType: Type.Optional(StringEnum(["cron", "interval"] as const)),
        countCapped: Type.Optional(Type.Boolean()),
        last: Type.Optional(Type.String()),
      }),
    ),
  ),
  events: Type.Optional(
    Type.Array(
      Type.Object({
        taskId: Type.String(),
        taskName: Type.Optional(Type.String()),
        enabled: Type.Optional(Type.Boolean()),
        maxFiresPerHour: Type.Optional(Type.Number()),
        firesLastHour: Type.Optional(Type.Integer()),
      }),
    ),
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
      uncertain: Type.Optional(Type.Integer()),
      passRate: Type.Optional(Type.Number()),
      costUsd: Type.Optional(Type.Number()),
      lastRun: Type.Optional(
        Type.Object({
          id: Type.String(),
          label: TaskRunLabel,
          startedAt: Type.Optional(Type.String()),
        }),
      ),
      recent: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String(),
            label: TaskRunLabel,
            startedAt: Type.Optional(Type.String()),
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
