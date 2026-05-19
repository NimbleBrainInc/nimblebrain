/**
 * Tool input schemas for the automations source. Imported by both the
 * platform in-process source (`src/tools/platform/automations.ts`) and the
 * standalone bundle server (`src/bundles/automations/src/server.ts`) so
 * the two consumers always agree on the wire shape.
 *
 * Shape convention (per src/tools/platform/CLAUDE.md §1.3):
 *
 *   create: { manifest: { ...config }, body: <prompt> }
 *   update: { name, manifest?: Partial<config>, body?: <new prompt> }
 *
 * `manifest` is the persistent automation definition; `body` is the prompt
 * sent to POST /v1/chat on each run — the analog of a skill's markdown
 * body. Operator-only fields (`source`, `bundleName`) are intentionally
 * absent from the LLM-facing schema; they live on the stored type and are
 * set by the runtime, never by an authoring caller.
 */

import { type Static, Type } from "@sinclair/typebox";
import { StringEnum } from "./_shared.ts";

// ── Shared sub-schemas ───────────────────────────────────────────────────

const Schedule = Type.Object(
  {
    type: StringEnum(["cron", "interval"] as const),
    expression: Type.Optional(
      Type.String({ description: "5-field cron expression (when type=cron)." }),
    ),
    timezone: Type.Optional(
      Type.String({ description: "IANA timezone. Default: system timezone." }),
    ),
    intervalMs: Type.Optional(
      Type.Number({
        minimum: 60000,
        description: "Interval in ms (when type=interval). Min 60000.",
      }),
    ),
  },
  { required: ["type"] },
);

const TokenBudget = Type.Object({
  maxInputTokens: Type.Optional(Type.Number()),
  maxOutputTokens: Type.Optional(Type.Number()),
  period: Type.Optional(StringEnum(["daily", "monthly"] as const)),
});

// Manifest fields shared by create + update. `name` is required for create
// (rebuilt with explicit required); update uses the same fields minus name
// (renames are not patchable; the kebab-case id would drift).
const ManifestFields = {
  name: Type.String({ description: "Human-readable name. Becomes the kebab-case id." }),
  description: Type.Optional(Type.String({ description: "What this automation does." })),
  schedule: Schedule,
  enabled: Type.Optional(
    Type.Boolean({ description: "Whether the automation runs. Default true." }),
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
    Type.Number({ description: "Max LLM iterations per run. Default 5, hard cap 15." }),
  ),
  maxInputTokens: Type.Optional(
    Type.Number({ description: "Max input tokens per run. Default 200000." }),
  ),
  maxRunDurationMs: Type.Optional(
    Type.Number({ description: "Max wall-clock per run (ms). Default 120000." }),
  ),
  tokenBudget: Type.Optional(TokenBudget),
};

// Update is a partial of the create-shape minus `name`. All fields except
// schedule become optional; schedule is partial-by-omission since it's
// already the only required field of the create-manifest beyond name.
const UpdateManifestFields = {
  description: ManifestFields.description,
  schedule: Type.Optional(Schedule),
  enabled: ManifestFields.enabled,
  skill: ManifestFields.skill,
  model: ManifestFields.model,
  maxIterations: ManifestFields.maxIterations,
  maxInputTokens: ManifestFields.maxInputTokens,
  maxRunDurationMs: ManifestFields.maxRunDurationMs,
  tokenBudget: ManifestFields.tokenBudget,
};

// ── Tool input schemas ───────────────────────────────────────────────────

export const AutomationsCreateInput = Type.Object(
  {
    manifest: Type.Object(ManifestFields, {
      required: ["name", "schedule"],
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
    StringEnum(["user", "agent", "bundle"] as const, { description: "Filter by source." }),
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
    StringEnum(["running", "success", "failure", "timeout", "cancelled", "skipped"] as const, {
      description: "Filter by run status.",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description: "ISO timestamp — only runs started on or after this time.",
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

// ── Tool output types ────────────────────────────────────────────────────
//
// These are TYPE-ONLY exports — no TypeBox runtime schema. The handler in
// `src/bundles/automations/src/server.ts` is the authority on output shape;
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
// Why these are self-contained (not imported from `bundles/automations/
// src/types.ts`): the codegen at `scripts/codegen-web-platform-schemas.ts`
// emits .d.ts files for the web package with `rootDir` pinned to
// `schemas/`. Cross-tree imports break that boundary. Drift between
// these types and the canonical `Automation` / `AutomationRun` is
// guarded at COMPILE time by
// `src/bundles/automations/src/output-types-drift-guard.ts`, which
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
export type AutomationLastRunStatus = "success" | "failure" | "timeout" | "skipped";

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
  schedule: string;
  enabled: boolean;
  source: "user" | "agent" | "bundle";
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
  total: number;
}

/**
 * Structural mirror of a single AutomationRun record as returned by
 * the handlers. Kept in sync with `AutomationRun` in
 * `bundles/automations/src/types.ts` via the assertion test referenced
 * above. New fields added there MUST also appear here.
 */
export interface AutomationRunRecord {
  id: string;
  automationId: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "success" | "failure" | "timeout" | "cancelled" | "skipped";
  conversationId?: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  iterations: number;
  error?: string;
  transient?: boolean;
  resultPreview?: string;
  stopReason?: "complete" | "max_iterations" | "length" | "content_filter" | "error" | "other";
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

/**
 * Schedule spec block on a stored automation. Mirror of `ScheduleSpec`.
 */
export interface AutomationScheduleSpec {
  type: "cron" | "interval";
  expression?: string;
  timezone?: string;
  intervalMs?: number;
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
  schedule: AutomationScheduleSpec;
  scheduleHuman: string;
  enabled: boolean;
  source: "user" | "agent" | "bundle";
  bundleName?: string;
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
}

/**
 * Discriminated union — `handleRun` returns one of two shapes:
 *
 *   { run: AutomationRunRecord }                     when the run finishes
 *                                                    inside the sync-wait
 *                                                    window (~30s default).
 *
 *   { status: "dispatched"; automationId; message }  when the run is still
 *                                                    in flight after the
 *                                                    window. Scheduler keeps
 *                                                    tracking; poll
 *                                                    `automations__runs`
 *                                                    for completion.
 *
 * Both shapes indicate the dispatch succeeded; only an error response
 * indicates failure to dispatch. Consumers MUST narrow before
 * dereferencing `run.*` — `as { run: ... }` is the anti-pattern that
 * caused the production CLI crash this type prevents.
 */
export type AutomationsRunOutput =
  | { run: AutomationRunRecord }
  | { status: "dispatched"; automationId: string; message: string };

export interface AutomationsCancelOutput {
  cancelled: boolean;
  id: string;
  message: string;
}
