/**
 * The private tools' schemas: the TypeBox authoring source for the `$defs`
 * entries of every tool `contract.ts` marks private. Only the host calls them
 * (CONTRACT.md §3).
 *
 * `contracts/scripts/emit-contracts.ts` turns this file into JSON, and
 * `--check` fails when the committed document differs. Nothing at runtime
 * imports this file.
 *
 * The run flow (CONTRACT.md §5): `due` → the host enqueues each occurrence →
 * a worker claims it → `begin_run` answers a skip or a work spec → the host
 * executes the spec → `end_run` records the outcome. Every instant here is one
 * the host decided (CONTRACT.md §6), as an RFC 3339 date-time with an offset.
 */

import { type TSchema, Type } from "@sinclair/typebox";
import {
  AllowedToolsField,
  MaxInputTokensField,
  MaxIterationsField,
  MaxRunDurationField,
  ModelField,
  NOTIFICATION_LEVELS,
  SkillsField,
  STOP_REASONS,
  StringEnum,
  ThinkingEffortField,
} from "./public.ts";

const Instant = (description: string) =>
  Type.String({ format: "date-time", minLength: 1, description });

/** An opaque string the implementation chose; the host passes it back unchanged and never parses it. */
const Opaque = (description: string, maxLength = 512) =>
  Type.String({ minLength: 1, maxLength, description });

const RunId = Opaque("The run's id, minted by the implementation.", 128);

/** The largest serialized `input` a work spec carries, in bytes (64 KiB). */
export const MAX_RUN_INPUT_BYTES = 64 * 1024;

// ── due ──────────────────────────────────────────────────────────────────

/** A run the implementation has decided is due, for the host to enqueue. */
export const Occurrence = Type.Object(
  {
    ownerId: Type.String({
      minLength: 1,
      description: "The owner the run acts for. The host runs it as this owner, in this workspace.",
    }),
    key: Opaque(
      "Names the occurrence within the workspace: the host enqueues it under this key, so a " +
        "repeat of the same occurrence is one item. Stable for as long as the occurrence is due.",
      256,
    ),
    ref: Opaque("What begin_run is called with when the occurrence is claimed."),
    notBefore: Type.Optional(
      Instant("Not due before this instant. Absent: due at once (a requested run)."),
    ),
  },
  { additionalProperties: false },
);

// ── begin_run ────────────────────────────────────────────────────────────

/** One spend account a run draws on. Only the implementation knows what its id stands for. */
export const SpendAccount = Type.Object(
  {
    id: Opaque(
      "Opaque. Runs naming the same id share one balance while any of them is in flight.",
      256,
    ),
    unit: StringEnum(["usd", "input_tokens", "output_tokens"] as const),
    remaining: Type.Number({
      description: "What is left, in `unit`. Read only from the first run in flight to name `id`.",
    }),
    sharedBy: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "The most runs that may draw on it at once (a batch's concurrency).",
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * What the host executes for an occurrence: an agent run. The host's door
 * wraps `input` and every `notes` entry in containment, renders the
 * instruction for `outputSchema`, clamps `limits` to the operator's ceilings,
 * enforces `spendAccounts`, and runs at most one run per `exclusiveKey`.
 */
export const AgentWorkSpec = Type.Object(
  {
    kind: Type.Literal("agent"),
    runId: RunId,
    grant: Type.String({
      minLength: 1,
      maxLength: 4096,
      description:
        "The run grant the implementation stored with the definition, returned verbatim. The " +
        "host verifies it before admitting the run.",
    }),
    prompt: Type.String({
      description:
        "The instruction that opens the run. Empty only with `skills`: the run then carries " +
        "the skills out.",
    }),
    input: Type.Optional(
      Type.Unsafe<unknown>({
        description: `The run's JSON input, at most ${MAX_RUN_INPUT_BYTES} bytes serialized. Data, never instructions: the host contains it.`,
      }),
    ),
    notes: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 8000 }), {
        maxItems: 8,
        description:
          "Context the implementation adds to this run (an event's items, a retry's reason). " +
          "Contained like `input`.",
      }),
    ),
    outputSchema: Type.Optional(
      Type.Unsafe<Record<string, unknown>>({
        type: "object",
        description:
          "The JSON Schema the deliverable must match. The host renders the instruction.",
      }),
    ),
    allowedTools: Type.Optional(AllowedToolsField),
    skills: Type.Optional(SkillsField),
    limits: Type.Optional(
      Type.Object(
        {
          maxIterations: Type.Optional(MaxIterationsField),
          maxInputTokens: Type.Optional(MaxInputTokensField),
          maxRunDurationMs: Type.Optional(MaxRunDurationField),
        },
        {
          additionalProperties: false,
          description: "The definition's caps. The host lowers each to its own ceiling.",
        },
      ),
    ),
    model: Type.Optional(ModelField),
    thinkingEffort: Type.Optional(ThinkingEffortField),
    spendAccounts: Type.Optional(Type.Array(SpendAccount, { maxItems: 8 })),
    exclusiveKey: Type.Optional(
      Opaque(
        "At most one run per key is in flight in the workspace. The host refuses a run whose " +
          "key is taken (outcome not_started, exclusive_busy).",
        256,
      ),
    ),
    trigger: Type.Optional(
      StringEnum(["scheduled", "manual", "event"] as const, {
        description: "What woke the run, for the host's telemetry. Decides nothing.",
      }),
    ),
  },
  { required: ["kind", "runId", "grant", "prompt"], additionalProperties: false },
);

/** The closed union of work a run may be. 1.0 has only `agent`. */
export const WorkSpec = Type.Union([AgentWorkSpec]);

// ── end_run ──────────────────────────────────────────────────────────────

/** Why a run did not end `complete`, as the host classified it. */
export const RUN_ERROR_CODES = [
  "grant_invalid",
  "membership_revoked",
  "exclusive_busy",
  "tools_unavailable",
  "skills_unavailable",
  "model_error",
  "internal",
] as const;

/** One tool call a run made, as the host saw it. Never its input or output. */
export const OutcomeToolCall = Type.Object(
  {
    name: Type.String({ minLength: 1, description: "The tool's name as the model called it." }),
    ok: Type.Boolean(),
    errorReason: Type.Optional(
      Type.String({
        maxLength: 128,
        description: "Why it failed, when the tool or the host said (`bad_input`, …).",
      }),
    ),
    held: Type.Optional(
      Type.Literal(true, { description: "It did not run: it waited for its tool's guidance." }),
    ),
    ms: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

/**
 * How a run ended. Every implementation receives it, so it is closed and small:
 * the host reports what only it observed, and the implementation derives
 * everything else (status, label, streaks, notices).
 */
export const RunOutcome = Type.Object(
  {
    startedAt: Instant("When the run started, or was refused when it never started."),
    endedAt: Instant("When it ended."),
    output: Type.String({
      description: "The deliverable: the final answer's text. Empty when none.",
    }),
    stopReason: StringEnum(STOP_REASONS, {
      description:
        "Why the run stopped. not_started: refused before its first model call (see `error`).",
    }),
    wrapUpLimit: Type.Optional(
      StringEnum(["max_iterations", "max_input_tokens"] as const, {
        description:
          "With stopReason complete: the limit that made the host tell the run to finish, which " +
          "it did. Its answer may leave work undone.",
      }),
    ),
    error: Type.Optional(
      Type.Object(
        {
          code: StringEnum(RUN_ERROR_CODES),
          transient: Type.Boolean({
            description:
              "Whether the same run may succeed later unchanged (an outage, a rate limit).",
          }),
          message: Type.Optional(
            Type.String({ maxLength: 2000, description: "Diagnostic, fit to show the owner." }),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    usage: Type.Object(
      {
        inputTokens: Type.Integer({ minimum: 0 }),
        outputTokens: Type.Integer({ minimum: 0 }),
        iterations: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    costUsd: Type.Number({ minimum: 0, description: "What its model calls cost." }),
    unpricedCalls: Type.Optional(
      Type.Integer({ minimum: 1, description: "Model calls with no known rates, not in costUsd." }),
    ),
    spendAccountId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "With stopReason spend_limit: the account that stopped it, one the spec named or one " +
          "the host holds (an id the implementation did not name).",
      }),
    ),
    limits: Type.Object(
      {
        maxIterations: Type.Integer({ minimum: 1 }),
        maxInputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
        maxRunDurationMs: Type.Integer({ minimum: 1 }),
      },
      {
        additionalProperties: false,
        description: "The caps the run executed under, after the host's ceilings.",
      },
    ),
    toolCalls: Type.Array(OutcomeToolCall, { maxItems: 1000 }),
    filesWritten: Type.Array(
      Type.Object(
        {
          uri: Type.String({ minLength: 1, description: "Opaque: the host's reference." }),
          name: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100, description: "Files the run wrote, as the host recorded them." },
    ),
    skillsDelivered: Type.Array(
      Type.Object(
        {
          name: Type.String(),
          loadedBy: StringEnum(["declared", "before_call", "tool_use", "activation"] as const),
          status: Type.Optional(StringEnum(["fetch_failed", "capped", "renamed_unheld"] as const)),
        },
        { additionalProperties: false },
      ),
    ),
  },
  {
    required: [
      "startedAt",
      "endedAt",
      "output",
      "stopReason",
      "usage",
      "costUsd",
      "limits",
      "toolCalls",
      "filesWritten",
      "skillsDelivered",
    ],
    additionalProperties: false,
  },
);

/** Something the host delivers to the run's owner. The implementation keeps no outbox. */
export const Notice = Type.Object(
  {
    id: Opaque("Stable for the event it reports, so a repeated end_run delivers it once.", 256),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.String({ maxLength: 2000 }),
    level: StringEnum(NOTIFICATION_LEVELS),
    link: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2048,
        description: "A resource the notice opens (the implementation's screen).",
      }),
    ),
  },
  { additionalProperties: false },
);

// ── offer_event ──────────────────────────────────────────────────────────

/** A notification a route delivered to a task: its presentation, never the connector's data. */
const OfferedEvent = Type.Object(
  {
    id: Opaque("Unique per source; delivery is at least once, so a repeat is the same event.", 256),
    source: Type.String({ minLength: 1 }),
    name: Type.String({ minLength: 1 }),
    level: StringEnum(NOTIFICATION_LEVELS, { description: "The level routes matched against." }),
    title: Type.String(),
    subject: Type.Optional(Type.String()),
    body: Type.Optional(Type.String()),
    link: Type.Optional(Type.String()),
    receivedAt: Instant("When the host received it."),
  },
  { additionalProperties: false },
);

// ── Every private tool ───────────────────────────────────────────────────

export const PRIVATE_SCHEMAS = {
  due: {
    input: Type.Object(
      {
        until: Instant("List occurrences due at or before this instant."),
        cursor: Type.Optional(Type.String({ description: "From the previous page's nextCursor." })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      },
      { required: ["until"], additionalProperties: false },
    ),
    output: Type.Object({
      occurrences: Type.Array(Occurrence),
      nextCursor: Type.Union([Type.String(), Type.Null()]),
    }),
  },
  begin_run: {
    input: Type.Object(
      {
        ref: Opaque("The occurrence's ref, as due listed it."),
        attempt: Type.Integer({
          minimum: 1,
          description: "The claim's attempt: above 1, an earlier claim may have begun the run.",
        }),
        token: Type.Integer({
          minimum: 0,
          description: "The claim's fencing token, greater than every earlier claim's.",
        }),
        now: Instant("The host's now: what lateness, budgets and backoff are judged against."),
      },
      { additionalProperties: false },
    ),
    output: {
      ...Type.Unsafe({
        anyOf: [
          Type.Object({
            decision: Type.Literal("skip"),
            reason: Type.String({ description: "Diagnostic only." }),
          }),
          Type.Object({ decision: Type.Literal("run"), work: WorkSpec }),
        ],
      }),
      type: "object",
    },
  },
  end_run: {
    input: Type.Object(
      {
        runId: RunId,
        token: Type.Integer({ minimum: 0, description: "The token begin_run was called with." }),
        outcome: RunOutcome,
      },
      { additionalProperties: false },
    ),
    output: Type.Object({
      notices: Type.Array(Notice),
    }),
  },
  check_runs: {
    input: Type.Object(
      {
        runIds: Type.Array(RunId, {
          maxItems: 1000,
          description: "Runs of this workspace the host has in flight.",
        }),
      },
      { additionalProperties: false },
    ),
    output: Type.Object({
      stop: Type.Array(Type.String(), {
        description: "Those to stop now (cancelled). Each ends with stopReason cancelled.",
      }),
    }),
  },
  offer_event: {
    input: Type.Object(
      {
        taskId: Type.String({ minLength: 1, description: "The task the route names." }),
        event: OfferedEvent,
        now: Instant("The host's now: what debounce and the fire ceiling are judged against."),
      },
      { additionalProperties: false },
    ),
    output: {
      ...Type.Unsafe({
        anyOf: [
          Type.Object({ accepted: Type.Literal(true) }),
          Type.Object({
            accepted: Type.Literal(false),
            outcome: StringEnum(["skipped", "denied"] as const, {
              description:
                "skipped: a condition that clears on its own (the task is off, or did not ask " +
                "for it). denied: a configuration refusal only a person changes.",
            }),
            classification: Type.String({ description: "Machine-readable cause." }),
            reason: Type.String({ description: "One line an operator can act on." }),
          }),
        ],
      }),
      type: "object",
    },
  },
  expire: {
    input: Type.Object(
      { endedBefore: Instant("Remove what ended before this instant.") },
      { additionalProperties: false },
    ),
    output: Type.Object({
      removed: Type.Object({
        runs: Type.Integer({ minimum: 0 }),
        tasks: Type.Integer({ minimum: 0 }),
      }),
    }),
  },
  delete_workspace: {
    input: Type.Object({}, { additionalProperties: false }),
    output: Type.Object({
      removed: Type.Object({
        tasks: Type.Integer({ minimum: 0 }),
        runs: Type.Integer({ minimum: 0 }),
        batches: Type.Integer({ minimum: 0 }),
      }),
    }),
  },
} as const satisfies Record<string, { input: TSchema; output: TSchema }>;

export type PrivateToolName = keyof typeof PRIVATE_SCHEMAS;
