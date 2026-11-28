/**
 * The private tools' schemas, and the named schemas they share (`occurrence`,
 * `work_spec`, `run_outcome`, `notice`): the TypeBox authoring source for the
 * `$defs` entries of every tool `contract.ts` marks private. Only the host
 * calls them (CONTRACT.md §3).
 *
 * `contracts/scripts/emit-contracts.ts` turns this file into JSON, and
 * `--check` fails when the committed document differs. Nothing at runtime
 * imports this file.
 *
 * The run flow (CONTRACT.md §5): `due` → the host enqueues each occurrence →
 * a worker claims it → `begin_run` answers a skip or a work spec → the host
 * executes the spec → `end_run` records the outcome. Every instant here is one
 * the host decided (CONTRACT.md §6).
 *
 * Every private input, every private output and every shared schema is
 * closed: `additionalProperties: false`
 * at every level, because the host refuses what it does not know (§15).
 */

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import {
  MaxInputTokensField,
  MaxIterationsField,
  MaxRunDurationField,
  NOTIFICATION_LEVELS,
  OneOf,
  StringEnum,
  THINKING_EFFORTS,
} from "./public.ts";

const CLOSED = { additionalProperties: false } as const;

/** An RFC 3339 date-time with an offset. */
const Instant = (description: string) => Type.String({ format: "date-time", description });

/** An opaque string the implementation chose; the host passes it back unchanged and never parses it. */
const Opaque = (description: string, maxLength = 512) =>
  Type.String({ minLength: 1, maxLength, description });

const RunId = Opaque("The run's id, minted by the implementation.", 128);

const Token = (description: string) => Type.Integer({ minimum: 0, description });

/** A run grant, opaque to the implementation, returned verbatim (CONTRACT.md §9). */
const Grant = (description: string) => Type.String({ minLength: 1, maxLength: 4096, description });

/** The version of this contract the host consumes, which bounds what the implementation answers. */
const Version = Type.String({
  pattern: "^1\\.(0|[1-9][0-9]*)$",
  description:
    "The version of this contract the host consumes. The answer holds nothing that version " +
    "does not define (CONTRACT.md §15).",
});

/** The names the shared schemas are emitted under in `$defs`. */
type SharedName = "occurrence" | "work_spec" | "run_outcome" | "notice";

/** A reference to one of the shared schemas below, typed as it. */
function Ref<T extends TSchema>(name: SharedName, _schema: T) {
  return Type.Unsafe<Static<T>>({ $ref: `#/$defs/${name}` });
}

/** The largest serialized `input` a work spec carries, in bytes (64 KiB). */
export const MAX_RUN_INPUT_BYTES = 64 * 1024;

// ── occurrence ───────────────────────────────────────────────────────────

/** A run the implementation has decided is owed, for the host to enqueue. */
export const Occurrence = Type.Object(
  {
    key: Opaque(
      "Names the occurrence within the workspace, and its notBefore exactly: the host " +
        "enqueues it under this key. An occurrence whose time changes is a new key.",
      256,
    ),
    ref: Opaque("What begin_run is called with when the occurrence is claimed."),
    notBefore: Type.Optional(
      Instant("Not due before this instant. Absent: due at once (a requested run)."),
    ),
  },
  CLOSED,
);

// ── work_spec ────────────────────────────────────────────────────────────

/** One spend account a run draws on. Only the implementation knows what its id stands for. */
const SpendAccount = Type.Object(
  {
    id: Opaque(
      "Opaque. Runs naming the same id share one balance while any of them is in flight.",
      256,
    ),
    unit: StringEnum(["usd", "input_tokens", "output_tokens"] as const),
    remaining: Type.Number({
      minimum: 0,
      description: "What is left, in `unit`. Read only from the first run in flight to name `id`.",
    }),
    sharedBy: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "The most runs that may draw on it at once (a batch's concurrency).",
      }),
    ),
  },
  CLOSED,
);

/**
 * An agent run through the host's door. The door wraps `input` and every
 * `notes` entry in containment, renders the instruction for `outputSchema`,
 * lowers `limits` to the operator's ceilings, enforces `spendAccounts` beside
 * its own, and runs at most one run per `exclusiveKey`.
 */
const AgentWorkSpec = Type.Object(
  {
    kind: Type.Literal("agent"),
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
    allowedTools: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Tool name globs, opaque to the implementation, matched by the host.",
      }),
    ),
    skills: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: 5,
        description: "Skill names, opaque to the implementation, resolved by the host.",
      }),
    ),
    limits: Type.Optional(
      Type.Object(
        {
          maxIterations: Type.Optional(MaxIterationsField),
          maxInputTokens: Type.Optional(MaxInputTokensField),
          maxRunDurationMs: Type.Optional(MaxRunDurationField),
        },
        { ...CLOSED, description: "The definition's caps. The host lowers each to its ceiling." },
      ),
    ),
    model: Type.Optional(
      Type.String({ minLength: 1, description: "provider:model-id or a slot name." }),
    ),
    thinkingEffort: Type.Optional(StringEnum(THINKING_EFFORTS)),
    spendAccounts: Type.Optional(Type.Array(SpendAccount, { maxItems: 8 })),
    exclusiveKey: Type.Optional(
      Opaque(
        "At most one run per key is in flight in the workspace. The host refuses a run whose " +
          "key is taken (not_started, exclusive_busy).",
        256,
      ),
    ),
    trigger: Type.Optional(
      StringEnum(["scheduled", "manual", "event"] as const, {
        description: "What woke the run, for the host's telemetry. Decides nothing.",
      }),
    ),
  },
  CLOSED,
);

/** The closed union of work a run may be. 1.0 has one kind, `agent`. */
export const WorkSpec = OneOf([AgentWorkSpec]);

// ── run_outcome ──────────────────────────────────────────────────────────

/** Why a run did not end `complete`, as the host classified it. */
export const RUN_ERROR_CODES = [
  "grant_invalid",
  "membership_revoked",
  "exclusive_busy",
  "tools_unavailable",
  "skills_unavailable",
  "work_invalid",
  "spend_limit",
  "model_error",
  "interrupted",
  "internal",
] as const;

/** Why the agent loop stopped. */
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

/** The stop reasons that come with an `error`. */
const STOPS_WITH_ERROR = ["error", "other", "not_started"] as const;

/** One tool call a run made, as the host saw it. Never its input or output. */
const OutcomeToolCall = Type.Object(
  {
    name: Type.String({ minLength: 1, description: "The tool's name as the model called it." }),
    ok: Type.Boolean(),
    errorReason: Type.Optional(
      StringEnum(["bad_input", "tool_error", "denied", "timeout", "unavailable"] as const, {
        description:
          "Why it failed: rejected for its arguments, answered an error, refused by policy, " +
          "ran out of time, or could not be reached.",
      }),
    ),
    ms: Type.Number({ minimum: 0 }),
  },
  CLOSED,
);

/**
 * How a run ended. Every implementation receives it, so it is closed and
 * small: the host reports what only it observed, and the implementation
 * derives everything else.
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
        "Why the run stopped. not_started: refused before its first model call. A host " +
        "shutdown is error with error.code internal and transient true, never cancelled.",
    }),
    wrapUpLimit: Type.Optional(
      StringEnum(["max_iterations", "max_input_tokens"] as const, {
        description:
          "With complete: the limit the host told the run to finish at. Its answer may leave " +
          "work undone.",
      }),
    ),
    error: Type.Optional(
      Type.Object(
        {
          code: StringEnum(RUN_ERROR_CODES),
          transient: Type.Boolean({
            description: "Whether the same run may succeed later unchanged.",
          }),
          message: Type.Optional(
            Type.String({ maxLength: 2000, description: "Diagnostic, fit to show the owner." }),
          ),
        },
        CLOSED,
      ),
    ),
    usage: Type.Object(
      {
        inputTokens: Type.Integer({ minimum: 0 }),
        outputTokens: Type.Integer({ minimum: 0 }),
        iterations: Type.Optional(Type.Integer({ minimum: 0 })),
      },
      CLOSED,
    ),
    costUsd: Type.Number({ minimum: 0, description: "What its model calls cost." }),
    unpricedCalls: Type.Optional(
      Type.Integer({ minimum: 1, description: "Model calls with no known rates, not in costUsd." }),
    ),
    spendAccountId: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "With spend_limit: the account that stopped it, one the spec named or one the host holds.",
      }),
    ),
    spendStop: Type.Optional(
      StringEnum(["exhausted", "reserved"] as const, {
        description:
          "With spend_limit: exhausted, the account's balance could not pay for another call; " +
          "reserved, other runs' reservations held what was left.",
      }),
    ),
    limits: Type.Optional(
      Type.Object(
        {
          maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
          maxInputTokens: Type.Optional(Type.Integer({ minimum: 1 })),
          maxRunDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { ...CLOSED, description: "The caps the run executed under, after the host's ceilings." },
      ),
    ),
    toolCalls: Type.Array(OutcomeToolCall, {
      maxItems: 1000,
      description: "In call order. A call that ran nothing is left out.",
    }),
    filesWritten: Type.Array(
      Type.Object(
        {
          uri: Type.String({ minLength: 1, description: "Opaque: the host's reference." }),
          name: Type.Optional(Type.String()),
        },
        CLOSED,
      ),
      { maxItems: 100, description: "Files the run wrote, as the host recorded them." },
    ),
    skillsDelivered: Type.Optional(
      Type.Array(
        Type.Object(
          {
            name: Type.String(),
            loadedBy: Type.String({ description: "Diagnostic: how it reached the run." }),
            status: Type.Optional(
              Type.String({ description: "Diagnostic: why it did not arrive whole." }),
            ),
          },
          CLOSED,
        ),
      ),
    ),
  },
  {
    ...CLOSED,
    allOf: [
      {
        if: { properties: { stopReason: { enum: [...STOPS_WITH_ERROR] } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then keyword.
        then: { required: ["error"] },
      },
      {
        if: { properties: { stopReason: { const: "complete" } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then keyword.
        then: { not: { required: ["error"] } },
        else: { not: { required: ["wrapUpLimit"] } },
      },
      {
        if: { properties: { stopReason: { not: { const: "spend_limit" } } } },
        // biome-ignore lint/suspicious/noThenProperty: JSON Schema's if/then keyword.
        then: { not: { anyOf: [{ required: ["spendAccountId"] }, { required: ["spendStop"] }] } },
      },
    ],
  },
);

// ── notice ───────────────────────────────────────────────────────────────

/** Something the host delivers to the owner. The implementation keeps no outbox. */
export const Notice = Type.Object(
  {
    id: Opaque("Stable for the event it reports, so a repeat is delivered once.", 256),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.String({ maxLength: 2000 }),
    level: StringEnum(NOTIFICATION_LEVELS),
  },
  CLOSED,
);

/** The schemas several tools share, emitted under these names in `$defs`. */
export const SHARED: Record<SharedName, TSchema> = {
  occurrence: Occurrence,
  work_spec: WorkSpec,
  run_outcome: RunOutcome,
  notice: Notice,
};

const Notices = Type.Array(Ref("notice", Notice));

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
    receivedAt: Instant("When the host received it."),
  },
  CLOSED,
);

// ── Every private tool ───────────────────────────────────────────────────

/** A closed object at the root of an output, which MCP requires to be `type: "object"`. */
function ObjectOneOf<T extends TSchema[]>(members: [...T]) {
  return Type.Unsafe<Static<T[number]>>({ type: "object", oneOf: members });
}

export const PRIVATE_SCHEMAS = {
  due: {
    input: Type.Object(
      {
        version: Version,
        until: Instant(
          "List occurrences due at or before this instant. The host calls due again before it.",
        ),
        cursor: Type.Optional(
          Type.String({
            description:
              "From the previous page's nextCursor, with the same until. A later page is judged at the first page's now, which the cursor carries.",
          }),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      },
      CLOSED,
    ),
    output: Type.Object(
      {
        occurrences: Type.Array(Ref("occurrence", Occurrence)),
        cancel: Type.Array(RunId, {
          description:
            "Runs the host has begun in this workspace that it should stop, bounded by the runs " +
            "the host has in flight there, which its admission bounds: each is answered " +
            "until the host's end_run for it lands. Every page carries the whole list.",
        }),
        nextCursor: Type.Union([Type.String(), Type.Null()]),
      },
      CLOSED,
    ),
  },
  begin_run: {
    input: Type.Object(
      {
        version: Version,
        ref: Opaque("The occurrence's ref, as due listed it."),
        attempt: Type.Integer({
          minimum: 1,
          description: "The claim's attempt: above 1, an earlier claim may have begun the run.",
        }),
        token: Token("The claim's fencing token, greater than every earlier claim's of this ref."),
      },
      CLOSED,
    ),
    output: ObjectOneOf([
      Type.Object(
        {
          decision: Type.Literal("skip"),
          reason: Type.String({ description: "Diagnostic only." }),
          interrupted: Type.Optional(
            Type.Object(
              { runId: RunId, token: Token("The token whose claim received its work spec.") },
              {
                ...CLOSED,
                description:
                  "An earlier claim's run that began and never ended. The host stops it if it " +
                  "still runs, and ends it with end_run (interrupted), usage from its metering.",
              },
            ),
          ),
          notices: Type.Optional(Notices),
        },
        CLOSED,
      ),
      Type.Object(
        {
          decision: Type.Literal("run"),
          runId: RunId,
          grant: Grant(
            "The run grant stored with the definition, verbatim. The host verifies it and takes " +
              "the run's owner from it.",
          ),
          work: Ref("work_spec", WorkSpec),
        },
        CLOSED,
      ),
    ]),
  },
  end_run: {
    input: Type.Object(
      {
        version: Version,
        runId: RunId,
        token: Token("The token whose begin_run received the run's work spec."),
        outcome: Ref("run_outcome", RunOutcome),
      },
      CLOSED,
    ),
    output: Type.Object({ notices: Notices }, CLOSED),
  },
  offer_event: {
    input: Type.Object(
      {
        version: Version,
        taskId: Type.String({ minLength: 1, description: "The task the route names." }),
        event: OfferedEvent,
      },
      CLOSED,
    ),
    output: ObjectOneOf([
      Type.Object(
        { accepted: Type.Literal(true), notices: Type.Optional(Notices) },
        { ...CLOSED, description: "Durably recorded before this answer." },
      ),
      Type.Object(
        {
          accepted: Type.Literal(false),
          outcome: StringEnum(["skipped", "denied"] as const, {
            description:
              "skipped: a condition that clears on its own. denied: a configuration refusal " +
              "only a person changes.",
          }),
          classification: Type.String({ description: "Machine-readable cause. Decides nothing." }),
          reason: Type.String({ description: "One line an operator can act on." }),
          notices: Type.Optional(Notices),
        },
        CLOSED,
      ),
    ]),
  },
  delete_workspace: {
    input: Type.Object({ version: Version }, CLOSED),
    output: Type.Object(
      {
        removed: Type.Object(
          {
            tasks: Type.Integer({ minimum: 0 }),
            runs: Type.Integer({ minimum: 0 }),
            batches: Type.Integer({ minimum: 0 }),
          },
          CLOSED,
        ),
      },
      CLOSED,
    ),
  },
} as const satisfies Record<string, { input: TSchema; output: TSchema }>;

export type PrivateToolName = keyof typeof PRIVATE_SCHEMAS;
