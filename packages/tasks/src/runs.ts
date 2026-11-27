/**
 * A run's record and what is derived from it: how an outcome the host
 * reported becomes the stored record (status, error, unrecovered tool
 * failures, the output-schema assessment), the execution and label every run
 * surface shows (derived, never stored), the run as public outputs carry it,
 * and the notices about runs (CONTRACT.md §4, §8, §11).
 */

import { checkAgainstSchema, parseJsonDeliverable } from "./json-schema.ts";
import type { Assessment, Notice, RunRecord, RunStatus, ToolFailure } from "./model.ts";

/** How much of the deliverable a run list carries. */
export const RESULT_PREVIEW_CHARS = 500;

/** The host's report of how a run ended (`run_outcome`), as the schema checked it. */
export interface Outcome {
  startedAt: string;
  endedAt: string;
  output: string;
  stopReason: string;
  wrapUpLimit?: string;
  error?: { code: string; transient: boolean; message?: string };
  usage: { inputTokens: number; outputTokens: number; iterations?: number };
  costUsd: number;
  unpricedCalls?: number;
  spendAccountId?: string;
  spendStop?: string;
  limits?: Record<string, number>;
  toolCalls: Array<{ name: string; ok: boolean; errorReason?: string; ms: number }>;
  filesWritten: Array<{ uri: string; name?: string }>;
  skillsDelivered?: Array<{ name: string; loadedBy: string; status?: string }>;
}

/** A run's whole result, as `run_result` returns it. */
export interface RunResult {
  completedAt: string;
  output: string;
  structured?: unknown;
  error?: string;
  activityLog: Array<{ name: string; ok: boolean; errorReason?: string; ms: number }>;
  outputFiles: Array<{ uri: string; name?: string }>;
  usage: { inputTokens: number; outputTokens: number; iterations: number };
  stopReason?: string;
  skillsDelivered?: Array<{ name: string; loadedBy: string; status?: string }>;
}

/** Stops at a limit, which keep whatever the run produced. */
const LIMIT_STOPS = new Set(["max_iterations", "max_input_tokens", "spend_limit", "length"]);

/** `not_started` codes that mean the run never had its turn, not that it failed. */
const NOT_STARTED_SKIPS = new Set([
  "exclusive_busy",
  "spend_limit",
  "grant_invalid",
  "membership_revoked",
]);

/** How a run ended: queued, running, skipped, completed, incomplete, failed or cancelled. */
export function executionOf(
  run: Pick<RunRecord, "status" | "stopReason" | "hasOutput" | "interruptedAt">,
): string {
  if (run.interruptedAt) return "failed";
  switch (run.status) {
    case "queued":
    case "running":
    case "skipped":
    case "cancelled":
      return run.status;
    case "success":
    case "degraded":
      return "completed";
    case "timeout":
      return run.hasOutput ? "incomplete" : "failed";
    default:
      return LIMIT_STOPS.has(run.stopReason ?? "") && run.hasOutput ? "incomplete" : "failed";
  }
}

const EXECUTION_LABELS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  skipped: "Skipped",
  cancelled: "Cancelled",
  failed: "Failed",
};

/** The one label a person reads. */
export function labelOf(run: RunRecord): string {
  const execution = executionOf(run);
  const fixed = EXECUTION_LABELS[execution];
  if (fixed) return fixed;
  if (run.assessment?.verdict === "fail") return "Poor result";
  if (execution === "incomplete") return "Needs review";
  if (run.unrecoveredToolFailures?.length || run.status === "degraded") return "Needs review";
  return "Succeeded";
}

/** Whether the run left a deliverable: it completed, or stopped at a limit with one. */
export function isAssessable(run: RunRecord): boolean {
  const execution = executionOf(run);
  return execution === "completed" || execution === "incomplete";
}

/** Whether the run has ended (or reads as ended: interrupted, provisionally). */
export function isEnded(run: RunRecord): boolean {
  const execution = executionOf(run);
  return execution !== "queued" && execution !== "running";
}

/** A run as every public surface returns it. `input` only where asked. */
export function runView(run: RunRecord, input?: unknown): Record<string, unknown> {
  const execution = executionOf(run);
  const completedAt = run.interruptedAt ?? run.completedAt;
  const startedAt = run.startedAt ?? (execution !== "queued" ? completedAt : undefined);
  const view: Record<string, unknown> = {
    id: run.id,
    taskId: run.taskId,
    execution,
    label: labelOf(run),
    trigger: run.trigger,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    iterations: run.iterations,
    toolCalls: run.toolCalls,
  };
  const optional: Record<string, unknown> = {
    startedAt,
    completedAt: execution === "queued" || execution === "running" ? undefined : completedAt,
    error: run.error,
    transient: run.transient,
    resultPreview: run.resultPreview,
    assessment: run.assessment,
    unrecoveredToolFailures: run.unrecoveredToolFailures,
    toolFailures: run.toolFailures,
    costUsd: run.costUsd,
    unpricedCalls: run.unpricedCalls,
    spendAccountId: run.spendAccountId,
    input,
    idempotencyKey: run.idempotencyKey,
    batchId: run.batchId,
    batchIndex: run.batchIndex,
  };
  for (const [k, v] of Object.entries(optional)) if (v !== undefined) view[k] = v;
  return view;
}

// ── Outcome → record ─────────────────────────────────────────────────────

/** The status and error an outcome reads as, before what its tool calls say. */
function baseStatus(outcome: Outcome): { status: RunStatus; error?: string; transient?: boolean } {
  const err = outcome.error;
  const message = err ? `${err.code}${err.message ? `: ${err.message}` : ""}` : undefined;
  switch (outcome.stopReason) {
    case "complete":
      return { status: "success" };
    case "cancelled":
      return { status: "cancelled", error: message ?? "Cancelled" };
    case "timeout":
      return {
        status: "timeout",
        error: message ?? "The run used its whole time allowance",
        transient: false,
      };
    case "not_started":
      return {
        status: NOT_STARTED_SKIPS.has(err?.code ?? "") ? "skipped" : "failure",
        error: message,
        transient: err?.transient,
      };
    case "spend_limit":
      return spendStatus(outcome, message);
    default:
      return {
        status: "failure",
        error: message ?? `Stopped: ${outcome.stopReason}`,
        transient: err?.transient,
      };
  }
}

/** A spend stop before the first model call never ran; one after it stopped at a limit. */
function spendStatus(outcome: Outcome, message: string | undefined) {
  const madeCall = outcome.usage.inputTokens > 0 || outcome.usage.outputTokens > 0;
  const error =
    message ??
    `Stopped by spend account ${outcome.spendAccountId ?? "(unnamed)"} (${outcome.spendStop ?? "exhausted"})`;
  return { status: (madeCall ? "failure" : "skipped") as RunStatus, error, transient: false };
}

/**
 * Tools whose failed calls no later call made good. A call refused for its
 * arguments (`bad_input`) ran nothing, so the next call to that tool is its retry.
 */
export function unresolvedFailures(calls: Outcome["toolCalls"]): string[] {
  const out = new Set<string>();
  calls.forEach((call, i) => {
    if (call.ok) return;
    const later = calls.slice(i + 1).filter((c) => c.name === call.name);
    const resolved =
      call.errorReason === "bad_input"
        ? later.find((c) => c.errorReason !== "bad_input")?.ok === true
        : later.some((c) => c.ok);
    if (!resolved) out.add(call.name);
  });
  return [...out];
}

/** A tool that failed for good, with the reason the host gave for its last failed call. */
function failureOf(calls: Outcome["toolCalls"], name: string): ToolFailure {
  const last = calls.findLast((c) => c.name === name && !c.ok);
  return last?.errorReason ? { name, errorReason: last.errorReason } : { name };
}

/** The fewest calls to one tool, all failed, that say the tool never worked. */
const ABANDONED_MIN_CALLS = 3;

/**
 * What the tool calls say about a run the model called complete: a call that
 * could not be reached, or a tool every call of which failed, is a failure; an
 * unresolved failure, or a limit that told the run to wrap up, leaves it
 * degraded. Null when they agree with `complete`.
 */
function completeVerdict(outcome: Outcome): { status: RunStatus; error: string } | null {
  const calls = outcome.toolCalls;
  const unreachable = [
    ...new Set(calls.filter((c) => c.errorReason === "unavailable").map((c) => c.name)),
  ];
  if (unreachable.length > 0) {
    return {
      status: "failure",
      error: `A tool could not be reached during the run: ${unreachable.join(", ")}`,
    };
  }
  const abandoned = abandonedTools(calls);
  if (abandoned.length > 0) {
    return {
      status: "failure",
      error: `Every call to ${abandoned.join(", ")} failed, so that work did not happen`,
    };
  }
  const unresolved = unresolvedFailures(calls);
  if (unresolved.length > 0) {
    return {
      status: "degraded",
      error: `Tool calls failed and were not retried to success: ${unresolved.join(", ")}`,
    };
  }
  if (outcome.wrapUpLimit) {
    return {
      status: "degraded",
      error: `Told to wrap up at its ${outcome.wrapUpLimit} limit; part of its work may be undone`,
    };
  }
  return null;
}

function abandonedTools(calls: Outcome["toolCalls"]): string[] {
  const total = new Map<string, number>();
  const failed = new Map<string, number>();
  for (const c of calls) {
    total.set(c.name, (total.get(c.name) ?? 0) + 1);
    if (!c.ok) failed.set(c.name, (failed.get(c.name) ?? 0) + 1);
  }
  return [...total]
    .filter(([n, t]) => t >= ABANDONED_MIN_CALLS && failed.get(n) === t)
    .map(([n]) => n);
}

/** The schema check of a deliverable, and its parsed value when it parsed. */
function assess(
  outputSchema: Record<string, unknown> | undefined,
  output: string,
  at: string,
): { assessment: Assessment; structured?: unknown } {
  if (!outputSchema) {
    return {
      assessment: {
        verdict: "not_assessed",
        reason: { code: "nothing_to_check", message: "The task has no output schema." },
        assessedAt: at,
      },
    };
  }
  const parsed = parseJsonDeliverable(output);
  if (!parsed) {
    const errors = ["(root): the deliverable is not JSON"];
    return { assessment: schemaFail(errors, at) };
  }
  const check = checkAgainstSchema(outputSchema, parsed.value);
  return check.valid
    ? {
        assessment: { verdict: "pass", schema: { valid: true }, assessedAt: at },
        structured: parsed.value,
      }
    : { assessment: schemaFail(check.errors, at), structured: parsed.value };
}

function schemaFail(errors: string[], at: string): Assessment {
  return {
    verdict: "fail",
    reason: {
      code: "schema_invalid",
      message: "The deliverable does not match the output schema.",
    },
    schema: { valid: false, errors },
    assessedAt: at,
  };
}

/**
 * The ended record of `run` from the host's outcome, and its result. `outputSchema` is
 * the one its work spec carried.
 */
export function recordOutcome(
  run: RunRecord,
  outcome: Outcome,
  outputSchema: Record<string, unknown> | undefined,
): { record: RunRecord; result: RunResult } {
  let { status, error, transient } = baseStatus(outcome);
  if (status === "success") {
    const verdict = completeVerdict(outcome);
    if (verdict) ({ status, error } = verdict);
  }
  const unrecovered = unresolvedFailures(outcome.toolCalls);
  const record: RunRecord = {
    ...run,
    status,
    startedAt: outcome.startedAt,
    completedAt: outcome.endedAt,
    stopReason: outcome.stopReason,
    inputTokens: outcome.usage.inputTokens,
    outputTokens: outcome.usage.outputTokens,
    iterations: outcome.usage.iterations ?? 0,
    toolCalls: outcome.toolCalls.length,
    costUsd: outcome.costUsd,
  };
  for (const field of [
    "interruptedAt",
    "cancelRequested",
    "error",
    "transient",
    "resultPreview",
    "hasOutput",
    "assessment",
    "unrecoveredToolFailures",
    "toolFailures",
    "events",
    "spendAccountId",
    "spendStop",
    "unpricedCalls",
  ] as const) {
    delete record[field];
  }
  if (error !== undefined) record.error = error;
  if (transient !== undefined) record.transient = transient;
  if (outcome.output) {
    record.hasOutput = true;
    record.resultPreview = outcome.output.slice(0, RESULT_PREVIEW_CHARS);
  }
  if (unrecovered.length > 0) {
    record.unrecoveredToolFailures = unrecovered;
    record.toolFailures = unrecovered.map((name) => failureOf(outcome.toolCalls, name));
  }
  if (outcome.spendAccountId) record.spendAccountId = outcome.spendAccountId;
  if (outcome.spendStop) record.spendStop = outcome.spendStop;
  if (outcome.unpricedCalls) record.unpricedCalls = outcome.unpricedCalls;
  let structured: unknown;
  if (isAssessable(record)) {
    const assessed = assess(outputSchema, outcome.output, outcome.endedAt);
    record.assessment = assessed.assessment;
    structured = assessed.structured;
  }
  return { record, result: resultOf(record, outcome, structured) };
}

function resultOf(record: RunRecord, outcome: Outcome, structured: unknown): RunResult {
  const result: RunResult = {
    completedAt: outcome.endedAt,
    output: outcome.output,
    activityLog: outcome.toolCalls.map((c) => ({ ...c })),
    outputFiles: outcome.filesWritten.map((f) => ({ ...f })),
    usage: {
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      iterations: record.iterations,
    },
    stopReason: outcome.stopReason,
  };
  if (structured !== undefined) result.structured = structured;
  if (record.error) result.error = record.error;
  if (outcome.skillsDelivered) result.skillsDelivered = outcome.skillsDelivered;
  return result;
}

/** The result of a run that ended without an outcome (skipped, cancelled while queued). */
export function resultOfRecord(run: RunRecord): RunResult {
  return {
    completedAt: run.completedAt ?? run.startedAt ?? "",
    output: "",
    activityLog: [],
    outputFiles: [],
    usage: {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      iterations: run.iterations,
    },
    ...(run.error ? { error: run.error } : {}),
  };
}

/** A run that ended without starting: skipped or cancelled, at `at`. */
export function endedUnstarted(
  run: RunRecord,
  status: "skipped" | "cancelled",
  reason: string,
  at: string,
): RunRecord {
  const record: RunRecord = { ...run, status, error: reason, completedAt: at };
  delete record.cancelRequested;
  delete record.events;
  return record;
}

// ── Notices ──────────────────────────────────────────────────────────────
//
// The inbox is the workspace's and a task is its owner's, so a notice names the run (or
// batch) and the owner by id and says what happened, never the task's name, prompt,
// input, output or error text (CONTRACT.md §11).

export function runFailedNotice(run: RunRecord): Notice {
  return {
    id: `run-failed:${run.id}`,
    title: "A scheduled task didn't work",
    body: `It ended without a result. Its owner (${run.ownerId}) can read run ${run.id} in Scheduled.`,
    level: "attention",
  };
}

export function poorResultNotice(run: RunRecord): Notice {
  return {
    id: `poor-result:${run.id}`,
    title: "A scheduled task's result needs a look",
    body: `Its deliverable did not match its output schema. Its owner (${run.ownerId}) can read run ${run.id} in Scheduled.`,
    level: "attention",
  };
}

/** Why a task was turned off, in words that name nothing of the task. */
export type DisableCause = "failures" | "budget" | "grant" | "fire_ceiling";

const DISABLE_BODIES: Record<DisableCause, string> = {
  failures: "It failed repeatedly, so its schedule is off until its owner turns it back on.",
  budget: "Its token budget is spent, so its schedule is off until its owner turns it back on.",
  grant:
    "Its run grant no longer admits runs (its owner's sign-in or membership changed). Its owner turns it back on by saving it again.",
  fire_ceiling:
    "It fired from events more often in an hour than its ceiling allows, so it is off until its owner breaks the loop and turns it back on.",
};

export function disabledNotice(
  id: string,
  ownerId: string,
  cause: DisableCause,
  runId?: string,
): Notice {
  const where = runId
    ? ` Its owner (${ownerId}) can read run ${runId} in Scheduled.`
    : ` Its owner is ${ownerId}.`;
  return {
    id: `task-disabled:${id}`,
    title: "A scheduled task was turned off",
    body: `${DISABLE_BODIES[cause]}${where}`,
    level: "attention",
  };
}
