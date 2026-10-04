/**
 * Tool input schemas for the automations app. Imported by both the
 * in-process source (`src/platform/automations/source.ts`) and the tool
 * handlers beside it (`src/platform/automations/server.ts`) so the two
 * consumers always agree on the wire shape.
 *
 * Shape convention (per src/platform/AGENTS.md §1.3):
 *
 *   create: { manifest: { ...config }, body: <prompt> }
 *   update: { name, manifest?: Partial<config>, body?: <new prompt> }
 *
 * `manifest` is the persistent automation definition; `body` is the prompt
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
        "`cron` and `interval` recur. `once` fires one time, at `at`, and then the automation " +
        "is disabled with no next run until a new `at` re-arms it: use it for a single action " +
        "at a set time instead of a cron with a fixed date, which recurs every year. `event` " +
        "has no next run: the automation fires when a notification a workspace admin routed to " +
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
          "Which notifications this automation wants (when type=event). Required for an event " +
          "schedule. A workspace admin must ALSO have written a delivery route naming this " +
          "automation — this narrows what arrives down that route, it does not open one.",
      }),
    ),
    debounceMs: Type.Optional(
      // Bounds mirror DEFAULT_EVENT_DEBOUNCE_MS / MAX_EVENT_DEBOUNCE_MS in
      // src/platform/automations/types.ts. Literals for the same reason as
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
          "Most runs this automation may fire from events in a rolling hour (when type=event). " +
          "Default 12, max 60. Exceeding it disables the automation — it is what terminates a " +
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
        description: "Most input tokens this automation's runs may use in total per period.",
      }),
    ),
    maxOutputTokens: Type.Optional(
      Type.Number({
        minimum: 1,
        description: "Most output tokens this automation's runs may use in total per period.",
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
      "too little left for another step stops with stopReason spend_limit. The automation " +
      "is then disabled and stays disabled until someone re-enables it. To bound a single " +
      "run, use maxInputTokens and maxIterations. Offer one when the automation runs often " +
      "or unattended for long.",
  },
);

// Manifest fields shared by create + update. `name` is required for create
// (rebuilt with explicit required); update uses the same fields minus name
// (renames are not patchable; the kebab-case id would drift).
const ManifestFields = {
  name: Type.String({ description: "Human-readable name. Becomes the kebab-case id." }),
  description: Type.Optional(Type.String({ description: "What this automation does." })),
  schedule: Type.Optional(
    Type.Object(Schedule.properties, {
      required: ["type"],
      description:
        "What fires it unattended. Omit for an automation that runs only when someone runs it " +
        "(automations__run).",
    }),
  ),
  enabled: Type.Optional(
    Type.Boolean({
      description:
        "Whether its schedule or events fire it. Default true. Run now (automations__run) runs it either way.",
    }),
  ),
  skill: Type.Optional(
    Type.String({
      description: "Force a specific skill match for this automation's runs.",
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
        "Tools this automation's runs may use, as names or globs: `gmail__*` for a workspace " +
        "connector's tools, `my_gmail__*` for your personal one, `files__read` for one tool. A " +
        "run cannot activate or call a tool outside the list; only nb__search and " +
        "nb__manage_tools pass without being listed, so name any other nb__ tool a run needs " +
        "(nb__use_skill for skills, nb__read_resource for resources). Prefer a `<connector>__*` " +
        "glob, since a connector can rename its tools. Omit or leave empty to allow every tool in the " +
        "workspace. May not name automations__create, automations__update, or automations__delete.",
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
  kind: Type.Optional(
    StringEnum(["saved", "oneoff"] as const, {
      description:
        "`saved` (default) for an automation to keep and list. `oneoff` for one made to be run " +
        "once with no schedule: it is kept with its run history but left out of " +
        "automations__list unless asked for.",
    }),
  ),
};

// Update is a partial of the create-shape minus `name` and `kind` (a one-off
// does not become a saved automation by a patch). `schedule: null` clears the
// schedule, leaving an automation that runs only when someone runs it.
const UpdateManifestFields = {
  description: ManifestFields.description,
  schedule: Type.Optional(
    Type.Union([Schedule, Type.Null()], {
      description:
        "New schedule, or null to remove it so nothing fires it unattended. Setting a new once " +
        "`at` on an automation that already ran once (or missed its time) re-arms and enables it.",
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
};

// ── Tool input schemas ───────────────────────────────────────────────────

export const AutomationsCreateInput = Type.Object(
  {
    manifest: Type.Object(ManifestFields, {
      required: ["name"],
      description: "Automation definition: identity, schedule, run-time policy.",
    }),
    body: Type.String({ description: "The prompt sent on each scheduled run." }),
  },
  { required: ["manifest", "body"] },
);
export type AutomationsCreateInput = Static<typeof AutomationsCreateInput>;

export const AutomationsUpdateInput = Type.Object(
  {
    name: Type.String({ description: "Name of the automation to update." }),
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
export type AutomationsUpdateInput = Static<typeof AutomationsUpdateInput>;

export const AutomationsDeleteInput = Type.Object(
  { name: Type.String({ description: "Name of the automation to delete." }) },
  { required: ["name"] },
);
export type AutomationsDeleteInput = Static<typeof AutomationsDeleteInput>;

export const AutomationsListInput = Type.Object({
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
    // Default/cap mirror AUTOMATIONS_LIST_DEFAULT_LIMIT / AUTOMATIONS_LIST_MAX_LIMIT
    // in src/limits.ts. Literals for the same reason as maxIterations above: this
    // schema is codegen'd under a strict rootDir that forbids importing from
    // outside src/platform/schemas/. server.ts imports the real constants.
    Type.Integer({
      minimum: 1,
      maximum: 500,
      description:
        "Max automations to return. Default 100, max 500. The response always reports the unpaged total and whether more remain.",
    }),
  ),
  cursor: Type.Optional(
    Type.String({
      description:
        "Opaque pagination cursor from a previous response's `nextCursor`. Omit for the first page.",
    }),
  ),
});
export type AutomationsListInput = Static<typeof AutomationsListInput>;

export const AutomationsStatusInput = Type.Object(
  {
    name: Type.String({ description: "Name of the automation." }),
    limit: Type.Optional(Type.Number({ description: "Max recent runs to include. Default: 5." })),
  },
  { required: ["name"] },
);
export type AutomationsStatusInput = Static<typeof AutomationsStatusInput>;

export const AutomationsRunsInput = Type.Object({
  automationId: Type.Optional(Type.String({ description: "Filter by automation ID." })),
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
        "history, which is kept indefinitely: pass the previous response's `nextBefore`. " +
        "Without it, only the most recent runs (up to 1000 per automation) are read.",
    }),
  ),
  limit: Type.Optional(Type.Number({ description: "Max runs to return. Default: 20." })),
});
export type AutomationsRunsInput = Static<typeof AutomationsRunsInput>;

export const AutomationsRunInput = Type.Object(
  { name: Type.String({ description: "Name of the automation to run." }) },
  { required: ["name"] },
);
export type AutomationsRunInput = Static<typeof AutomationsRunInput>;

export const AutomationsCancelInput = Type.Object(
  { name: Type.String({ description: "Name of the automation to cancel." }) },
  { required: ["name"] },
);
export type AutomationsCancelInput = Static<typeof AutomationsCancelInput>;

export const AutomationsRunResultInput = Type.Object(
  {
    name: Type.String({ description: "Name of the automation." }),
    runId: Type.String({ description: "The run id (from a run record) to fetch the result for." }),
  },
  { required: ["name", "runId"] },
);
export type AutomationsRunResultInput = Static<typeof AutomationsRunResultInput>;

// ── Tool output types ────────────────────────────────────────────────────
//
// These are TYPE-ONLY exports — no TypeBox runtime schema. The handler in
// `src/platform/automations/server.ts` is the authority on output shape;
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
// `src/platform/automations/types.ts`): the codegen at
// `scripts/codegen-web-platform-schemas.ts`
// emits .d.ts files for the web package with `rootDir` pinned to
// `schemas/`. Cross-tree imports break that boundary. Drift between
// these types and the canonical `Automation` / `AutomationRun` is
// guarded at COMPILE time by
// `src/platform/automations/output-types-drift-guard.ts`, which
// `bun run check` validates as part of the standard CI gate. When you
// change `Automation` or `AutomationRun`, that file's type-level
// constraints fail to compile against the corresponding mirror here —
// the build error points at the field that drifted.
//
// When you change a handler return shape, update the matching output
// type here in the same commit. The output type is the contract.

/**
 * Status of the most recent automation run, as exposed via the list/
 * summary surface. Mirrors `AutomationRun["status"]` minus `"running"`
 * — the list view shows the most recent COMPLETED run's outcome, never
 * one in flight.
 */
export type AutomationLastRunStatus = "success" | "degraded" | "failure" | "timeout" | "skipped";

/**
 * Summary row returned per automation by `handleList`. Subset of the
 * stored `Automation` shape plus a couple of human-formatted fields the
 * UI surfaces directly. `lastRunAt` / `nextRunAt` are human-relative
 * strings (e.g. "in 2h", "4h ago") — the raw ISO timestamps stay on the
 * stored `Automation`.
 */
export interface AutomationSummary {
  id: string;
  name: string;
  description?: string;
  /** Human-readable trigger, e.g. "Daily at 8:00 AM HST", "Once at …", "Manual only". */
  schedule: string;
  /** The schedule's type, or `none` when nothing fires it unattended. */
  scheduleType: "cron" | "interval" | "event" | "once" | "none";
  kind: "saved" | "oneoff";
  /** Set when a once schedule has fired or missed its time; the automation is inert until re-armed. */
  onceDone?: AutomationOnceDone;
  enabled: boolean;
  source: "user" | "agent";
  runCount: number;
  lastRunStatus: AutomationLastRunStatus | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  estimatedCostPerDay: number;
}

export interface AutomationsListOutput {
  automations: AutomationSummary[];
  /** Matches for the given filters BEFORE the page cap — not `automations.length`. */
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

/**
 * Structural mirror of a single AutomationRun record as returned by
 * the handlers. Kept in sync with `AutomationRun` in
 * `platform/automations/types.ts` via the assertion test referenced
 * above. New fields added there MUST also appear here.
 */
export interface AutomationRunRecord {
  id: string;
  automationId: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "success" | "degraded" | "failure" | "timeout" | "cancelled" | "skipped";
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
}

/**
 * One tool call from a run's activity log. Mirror of `RunToolCall` in
 * `platform/automations/types.ts` (kept here to avoid a cross-tree import;
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
 * `AutomationRunResult` in `platform/automations/types.ts`. A run is not a
 * conversation: the result carries the final output, the activity log, and refs
 * to any files the run wrote in the workspace file store.
 */
export interface AutomationsRunResultOutput {
  runId: string;
  automationId: string;
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
}

/**
 * Token budget block on a stored automation. Mirror of the
 * `TokenBudget` interface; kept here to avoid a cross-tree import
 * (see top-of-section comment).
 */
export interface AutomationTokenBudget {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  period?: "daily" | "monthly";
}

/** How a once schedule's occurrence ended, and when. Mirror of `OnceDone`. */
export interface AutomationOnceDone {
  at: string;
  outcome: "ran" | "missed";
}

/**
 * Schedule spec block on a stored automation. Mirror of `ScheduleSpec`.
 */
export interface AutomationScheduleSpec {
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
 * Automation detail returned by `handleStatus`. Spreads the stored
 * Automation and overlays a few computed fields the UI consumes
 * directly: humanized schedule + relative-time strings, cost numbers,
 * and undefined→null coercion on optional fields (`tokenBudget`,
 * `budgetResetAt`) so JSON consumers see a consistent shape per field.
 */
export interface AutomationStatusDetail {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  schedule?: AutomationScheduleSpec;
  kind?: "saved" | "oneoff";
  onceDone?: AutomationOnceDone;
  scheduleHuman: string;
  enabled: boolean;
  source: "user" | "agent";
  ownerId?: string;
  workspaceId?: string;
  model?: string | null;
  skill?: string;
  allowedTools?: string[];
  maxIterations?: number;
  maxInputTokens?: number;
  maxRunDurationMs?: number;
  runCount: number;
  consecutiveErrors: number;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  tokenBudget: AutomationTokenBudget | null;
  budgetResetAt: string | null;
  lastRunAt?: string;
  lastRunAtHuman: string | null;
  lastRunStatus?: AutomationLastRunStatus;
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

export interface AutomationsStatusOutput {
  automation: AutomationStatusDetail;
  recentRuns: AutomationRunRecord[];
}

export interface AutomationsRunsOutput {
  runs: AutomationRunRecord[];
  total: number;
  /**
   * Pass as `before` for the next older page of one automation's history;
   * absent when nothing older remains (or when runs span every automation).
   */
  nextBefore?: string;
}

/**
 * Discriminated union — `handleRun` returns one of two shapes:
 *
 *   { run: AutomationRunRecord; enabled; message? }  when the run finishes
 *                                                    inside the sync-wait
 *                                                    window (~30s default).
 *
 *   { status: "dispatched"; automationId;            when the run is still
 *     startedAt; enabled; message }                  in flight after the
 *                                                    window. It keeps going;
 *                                                    its record lands in
 *                                                    `automations__runs`
 *                                                    (`since: startedAt`)
 *                                                    when it ends.
 *
 *   { status: "queued"; automationId; position;     when every run slot was
 *     queuedAt; enabled; message }                   busy. It starts as soon
 *                                                    as a slot frees; its record
 *                                                    lands in `automations__runs`
 *                                                    (`since: queuedAt`) when it
 *                                                    ends. `automations__cancel`
 *                                                    removes it from the queue.
 *
 * A Run now the scheduler refuses (already running or queued, a full queue, a
 * spent token budget) returns the first shape with a `skipped` run whose
 * `error` says why.
 *
 * `enabled` is the automation's own flag. Run now runs a disabled automation,
 * because it is a deliberate act and the create form's test run depends on
 * it; a disabled automation is not fired by its schedule or by events, and
 * `message` says so.
 *
 * Both shapes indicate the dispatch succeeded; only an error response
 * indicates failure to dispatch. Consumers MUST narrow before
 * dereferencing `run.*` — `as { run: ... }` is the anti-pattern that
 * caused the production CLI crash this type prevents.
 */
export type AutomationsRunOutput =
  | { run: AutomationRunRecord; enabled: boolean; message?: string }
  | {
      status: "dispatched";
      automationId: string;
      startedAt: string;
      enabled: boolean;
      message: string;
    }
  | {
      status: "queued";
      automationId: string;
      /** 1 is next to start. */
      position: number;
      queuedAt: string;
      enabled: boolean;
      message: string;
    };

export interface AutomationsCancelOutput {
  cancelled: boolean;
  id: string;
  message: string;
}

/**
 * A stored automation, as `automations__create` and `automations__update`
 * return it. Mirror of `Automation` (`src/platform/automations/types.ts`),
 * held to it by `src/platform/automations/output-types-drift-guard.ts`.
 */
export interface AutomationRecord {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  schedule?: AutomationScheduleSpec;
  kind?: "saved" | "oneoff";
  onceDone?: AutomationOnceDone;
  skill?: string;
  allowedTools?: string[];
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
  lastRunStatus?: AutomationLastRunStatus;
  nextRunAt?: string;
  runCount: number;
  consecutiveErrors: number;
  disabledAt?: string;
  disabledReason?: string;
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  tokenBudget?: AutomationTokenBudget;
  budgetResetAt?: string;
}

/**
 * The caps a run of the automation executes under: each cap the definition
 * sets, lowered to the runtime's per-run ceiling, and the runtime default held
 * to the ceiling where it sets none. `maxInputTokens` is absent when the run
 * has no input-token cap (neither the definition nor the runtime sets one).
 * `message` names any cap that was lowered.
 */
export interface AutomationEffectiveLimits {
  maxIterations: number;
  maxInputTokens?: number;
  maxRunDurationMs: number;
}

export interface AutomationsCreateOutput {
  automation: AutomationRecord;
  created: boolean;
  message: string;
  effectiveLimits: AutomationEffectiveLimits;
}

export interface AutomationsUpdateOutput {
  automation: AutomationRecord;
  updated: boolean;
  message: string;
  effectiveLimits: AutomationEffectiveLimits;
}

export interface AutomationsDeleteOutput {
  deleted: boolean;
  id: string;
  message: string;
}
