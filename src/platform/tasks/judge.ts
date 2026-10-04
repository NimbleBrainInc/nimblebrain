/**
 * Judging a run through a connected MCP judge server (ADR-0045, ADR-0020).
 *
 * The runtime names no judge. A judge server is any source the workspace
 * connected that exposes both `judge` and `list_judges` (the judge tool
 * contract). Connecting one is the workspace's consent to send deliverables to
 * it, so nothing here connects one: with none connected, a run with criteria
 * is `not_assessed` and says so.
 *
 * The call goes through the unattended dispatch door as the task's owner, in
 * the run's workspace, so the owner's tool policy and the wall apply exactly as
 * they would to any call the run itself made.
 */

import type { ToolResult } from "../../engine/types.ts";
import { log } from "../../observability/log.ts";
import {
  buildJudgeState,
  decideCriteria,
  type JudgeAnswer,
  schemaCheckOf,
  thresholdOf,
  verdictOf,
} from "./assessment.ts";
import type { Criterion, RunAssessment, Task, TaskRun, TaskRunResult } from "./types.ts";

/** The tools that make a source a judge server. */
export const JUDGE_TOOL = "judge";
export const LIST_JUDGES_TOOL = "list_judges";

/** A connected source and the bare names of its tools. */
export interface JudgeSourceView {
  name: string;
  toolNames: string[];
}

/** One tool call's outcome, as the unattended dispatch door reports it. */
export interface JudgeDispatchResult {
  outcome: "ok" | "denied" | "skipped" | "error";
  result?: ToolResult;
  error?: string;
  classification?: string;
}

/** What judging needs from the runtime. */
export interface JudgePort {
  /** The sources connected in a workspace, each with its bare tool names. */
  sources(wsId: string): Promise<JudgeSourceView[]>;
  /** Call one tool (`<source>__<tool>`) as `ownerId` in `wsId`. Never throws. */
  call(opts: {
    wsId: string;
    ownerId: string;
    tool: string;
    input: Record<string, unknown>;
    reason: string;
  }): Promise<JudgeDispatchResult>;
}

/**
 * Pick the judge server for a task among a workspace's connected sources:
 * the one the task names, else the only one connected. Never a guess between
 * several, and never one the workspace has not connected.
 */
export function findJudgeServer(
  sources: JudgeSourceView[],
  named: string | undefined,
): { server: string } | { reason: string } {
  const isJudge = (s: JudgeSourceView) =>
    s.toolNames.includes(JUDGE_TOOL) && s.toolNames.includes(LIST_JUDGES_TOOL);
  const judges = sources.filter(isJudge);
  if (named !== undefined) {
    if (judges.some((s) => s.name === named)) return { server: named };
    if (sources.some((s) => s.name === named)) {
      return {
        reason: `"${named}" is connected but is not a judge server (it does not expose ${JUDGE_TOOL} and ${LIST_JUDGES_TOOL})`,
      };
    }
    return { reason: `the judge server "${named}" is not connected in this workspace` };
  }
  if (judges.length === 1 && judges[0]) return { server: judges[0].name };
  if (judges.length === 0) {
    return {
      reason:
        "no judge server is connected in this workspace; connect one to judge this task's criteria",
    };
  }
  return {
    reason:
      `more than one judge server is connected (${judges.map((s) => s.name).join(", ")}); ` +
      "name one in the task's judge.server",
  };
}

/** Judge error codes worth another try: the judge or its upstream is briefly unavailable. */
const RETRYABLE_CODES = new Set(["rate_limited", "upstream_unavailable", "upstream_timeout"]);

/**
 * Waits before each retry of a retryable judge error: three retries over about
 * 30 seconds, then the run is `not_assessed`. Short, because a run's
 * assessment holds its record open for a waiting caller (`tasks__run`), and
 * bounded, because a judge that is down for a minute is down for this run.
 */
export const JUDGE_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 20_000];

/** Per-call ceiling on one judge call, enforced (and cancelled) by the dispatch door. */
export const JUDGE_CALL_TIMEOUT_MS = 30_000;

/** Ceiling on a judge's serialized result: fifty answers with rationales fit well inside it. */
export const JUDGE_RESULT_MAX_BYTES = 256 * 1024;

export interface AssessDeps {
  port: JudgePort;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  retryDelaysMs?: readonly number[];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The judge error's classified code, read from the error envelope a judge returns. */
function errorCodeOf(result: ToolResult | undefined): string {
  const error = result?.structuredContent?.error;
  if (
    error &&
    typeof error === "object" &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return "unclassified";
}

type JudgeCall = { ok: true; payload: Record<string, unknown> } | { ok: false; reason: string };

/** The structured payload of a successful call: `structuredContent`, else its text parsed as JSON. */
function payloadOf(result: ToolResult | undefined): Record<string, unknown> | null {
  if (!result) return null;
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = result.content?.find((c) => c.type === "text");
  if (!text || text.type !== "text") return null;
  try {
    const parsed = JSON.parse(text.text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * What one dispatch outcome means for the call: its payload, a final reason,
 * or a judge error code (retried when it is a retryable one).
 */
function readDispatch(res: JudgeDispatchResult): JudgeCall | { code: string } {
  if (res.outcome === "ok") {
    const payload = payloadOf(res.result);
    return payload
      ? { ok: true, payload }
      : { ok: false, reason: "the judge returned a result the runtime could not read" };
  }
  if (res.outcome === "skipped") {
    return { ok: false, reason: "the task's owner is not a member of its workspace" };
  }
  if (res.outcome === "denied") {
    return { ok: false, reason: `the judge call was refused (${res.classification ?? "denied"})` };
  }
  if (res.classification === "tool_error") return { code: errorCodeOf(res.result) };
  // The door's own deadline is the judge not answering in time.
  if (res.classification === "timeout") return { code: "upstream_timeout" };
  return { code: res.classification ?? "unclassified" };
}

/** Call `judge` once, retrying a retryable error with backoff. */
async function callJudge(
  deps: AssessDeps,
  opts: {
    wsId: string;
    ownerId: string;
    server: string;
    input: Record<string, unknown>;
    reason: string;
  },
): Promise<JudgeCall> {
  const delays = deps.retryDelaysMs ?? JUDGE_RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const read = readDispatch(
      await deps.port.call({
        wsId: opts.wsId,
        ownerId: opts.ownerId,
        tool: `${opts.server}__${JUDGE_TOOL}`,
        input: opts.input,
        reason: opts.reason,
      }),
    );
    if (!("code" in read)) return read;
    const retryable = RETRYABLE_CODES.has(read.code);
    const delay = delays[attempt];
    if (!retryable) return { ok: false, reason: `the judge answered ${read.code}` };
    if (delay === undefined) {
      return {
        ok: false,
        reason: `the judge was unavailable (${read.code}) after ${attempt + 1} attempts`,
      };
    }
    await sleep(delay);
  }
}

/** The criteria as the judge contract takes them. */
function contractCriteria(criteria: Criterion[]): Array<Record<string, unknown>> {
  return criteria.map((c) => ({
    id: c.id,
    rule: c.rule,
    type: c.type,
    ...(c.levels ? { levels: c.levels } : {}),
    ...(c.options ? { options: c.options } : {}),
    ...(c.pass !== undefined ? { pass: c.pass } : {}),
  }));
}

/** The judge's reported usage, in the run record's names; undefined when it reported none. */
function readUsage(raw: unknown): RunAssessment["usage"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  const usage: NonNullable<RunAssessment["usage"]> = {};
  if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
  if (typeof u.cost_usd === "number") usage.costUsd = u.cost_usd;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Read the contract's output, or null when it is not that shape. */
function readJudgeOutput(payload: Record<string, unknown>): {
  judge: { id: string; version?: string; calibrated: boolean };
  answers: JudgeAnswer[];
  usage?: RunAssessment["usage"];
} | null {
  const judge = payload.judge as Record<string, unknown> | undefined;
  const answers = payload.answers;
  if (!judge || typeof judge.id !== "string" || typeof judge.calibrated !== "boolean") return null;
  if (!Array.isArray(answers)) return null;
  const wellFormed = answers.every(
    (a) => a && typeof a === "object" && typeof (a as JudgeAnswer).id === "string",
  );
  if (!wellFormed) return null;
  const usage = readUsage(payload.usage);
  return {
    judge: {
      id: judge.id,
      ...(typeof judge.version === "string" ? { version: judge.version } : {}),
      calibrated: judge.calibrated,
    },
    answers: answers as JudgeAnswer[],
    ...(usage ? { usage } : {}),
  };
}

/**
 * Assess one run that left a deliverable, cheapest check first:
 *
 *   1. The output schema, from the validity the executor already recorded:
 *      invalid is `fail`, and no judge is called.
 *   2. The criteria, judged in one call to the workspace's judge server, each
 *      decided here by its pass rule, the verdict by the task's threshold.
 *
 * No schema and no criteria is `not_assessed`. Every failure to judge (no
 * judge, a refused call, an error, an unreadable answer) is `not_assessed`
 * with its reason. Never throws, and never touches the run's execution.
 */
export async function assessRun(
  task: Task,
  run: TaskRun,
  result: TaskRunResult | null,
  deps: AssessDeps,
): Promise<RunAssessment> {
  const assessedAt = (deps.now?.() ?? new Date()).toISOString();
  const schema = task.outputSchema ? schemaCheckOf(run) : undefined;
  const base = { assessedAt, ...(schema ? { schema } : {}) };
  if (schema && !schema.valid) {
    return { ...base, verdict: "fail", reason: "the deliverable does not match the output schema" };
  }
  const criteria = task.criteria ?? [];
  if (criteria.length === 0) {
    return schema
      ? { ...base, verdict: "pass" }
      : {
          ...base,
          verdict: "not_assessed",
          reason: "the task has no output schema and no criteria",
        };
  }
  try {
    return { ...base, ...(await judgeCriteria(task, criteria, run, result, deps)) };
  } catch (err) {
    log.warn("[tasks] assessment failed", {
      taskId: task.id,
      runId: run.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ...base, verdict: "not_assessed", reason: "assessment failed inside the runtime" };
  }
}

/** The judge's part of an assessment: the verdict on the criteria, or why there is none. */
async function judgeCriteria(
  task: Task,
  criteria: Criterion[],
  run: TaskRun,
  result: TaskRunResult | null,
  deps: AssessDeps,
): Promise<Omit<RunAssessment, "assessedAt" | "schema">> {
  const notAssessed = (reason: string) => ({ verdict: "not_assessed" as const, reason });
  if (!result) return notAssessed("the run left no result to judge");
  const wsId = task.workspaceId;
  const ownerId = task.ownerId;
  if (!wsId || !ownerId) return notAssessed("the task names no workspace or owner");

  const found = findJudgeServer(await deps.port.sources(wsId), task.judge?.server);
  if ("reason" in found) return notAssessed(found.reason);

  const { state, truncated } = buildJudgeState(run, result);
  const input: Record<string, unknown> = { criteria: contractCriteria(criteria), state };
  if (task.judge?.id) {
    input.judge = {
      id: task.judge.id,
      ...(task.judge.options ? { options: task.judge.options } : {}),
    };
  }
  const called = await callJudge(deps, {
    wsId,
    ownerId,
    server: found.server,
    input,
    reason: `task-assessment:${task.id}/${run.id}`,
  });
  const withTruncation = truncated ? { stateTruncated: true } : {};
  if (!called.ok) return { ...notAssessed(called.reason), ...withTruncation };

  const out = readJudgeOutput(called.payload);
  if (!out) {
    return {
      ...notAssessed("the judge returned a result the runtime could not read"),
      ...withTruncation,
    };
  }
  const judge = { server: found.server, ...out.judge };
  const usage = out.usage ? { usage: out.usage } : {};
  const decided = decideCriteria(criteria, out.answers);
  if ("unreadable" in decided) {
    return { ...notAssessed(decided.unreadable), judge, ...usage, ...withTruncation };
  }
  return {
    verdict: verdictOf(decided.results, thresholdOf(task)),
    criteria: decided.results,
    judge,
    ...usage,
    ...withTruncation,
  };
}
