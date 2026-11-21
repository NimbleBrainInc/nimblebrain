/**
 * Seed the Scheduled page demo's workdir (`bun run dev:scheduled-demo`).
 *
 * Dev tooling, not a migration: it runs before every launch of the demo and
 * writes only into the demo's own workdir. The workspace and the dev user go
 * through `WorkspaceStore` and `UserStore`; tasks, runs, and batches through
 * the tasks store (`saveTask`, `saveRunResult`, `appendRun`, `saveBatch`,
 * `writeBatchItems`, `saveBatchKey`), each run's result before its index
 * line, as the scheduler writes them. So the runtime boots it like any
 * workdir and the panel derives every task's health from the runs.
 *
 * Idempotent: the workspace is found by name before it is created, and the
 * dev user's tasks directory in it is removed and written again on every
 * launch, with times relative to now, so the board always reads as current.
 */

import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { Cron } from "croner";
import { UserStore } from "../../../src/identity/user.ts";
import {
  countItems,
  saveBatch,
  saveBatchKey,
  writeBatchItems,
} from "../../../src/platform/tasks/batch-store.ts";
import { workspaceTasksDir } from "../../../src/platform/tasks/paths.ts";
import { computeNextRunAt } from "../../../src/platform/tasks/scheduler.ts";
import { appendRun, saveRunResult, saveTask } from "../../../src/platform/tasks/store.ts";
import type {
  Batch,
  BatchItem,
  RunAssessment,
  Task,
  TaskRun,
} from "../../../src/platform/tasks/types.ts";
import type { Workspace } from "../../../src/workspace/types.ts";
import { WorkspaceStore } from "../../../src/workspace/workspace-store.ts";
import {
  BATCHES,
  type BatchFixture,
  DAY,
  DEMO_USER_ID,
  DEMO_WORKSPACE,
  HOUR,
  MINUTE,
  ONEOFFS,
  type OneoffFixture,
  type Outcome,
  TASKS,
  type TaskFixture,
} from "./fixtures.ts";

export interface SeedOptions {
  workDir: string;
  /** The moment every fixture time is relative to. Default: now. */
  now?: number;
}

export interface SeedSummary {
  workspaceId: string;
  tasks: number;
  runs: number;
  oneoffs: number;
  batches: number;
}

export async function seedScheduledDemo(opts: SeedOptions): Promise<SeedSummary> {
  const { workDir } = opts;
  const now = opts.now ?? Date.now();
  await ensureDevUser(workDir);
  const ws = await ensureWorkspace(new WorkspaceStore(workDir));

  // The seed is the whole demo for this owner: start from nothing each launch.
  rmSync(workspaceTasksDir(workDir, ws.id, DEMO_USER_ID), { recursive: true, force: true });

  const writer: Writer = { workDir, wsId: ws.id, runs: 0 };
  for (const fixture of TASKS) seedTask(writer, fixture, now);
  for (const fixture of ONEOFFS) seedOneoff(writer, fixture, now);
  for (const fixture of BATCHES) seedBatch(writer, fixture, now);

  return {
    workspaceId: ws.id,
    tasks: TASKS.length,
    runs: writer.runs,
    oneoffs: ONEOFFS.length,
    batches: BATCHES.length,
  };
}

/** The dev identity's profile, which the dev provider would otherwise create on first request. */
async function ensureDevUser(workDir: string): Promise<void> {
  const users = new UserStore(workDir);
  if (await users.get(DEMO_USER_ID)) return;
  await users.create({
    id: DEMO_USER_ID,
    email: "dev@localhost",
    displayName: "Dev",
    orgRole: "admin",
  });
}

async function ensureWorkspace(store: WorkspaceStore): Promise<Workspace> {
  const existing = (await store.list()).find((ws) => ws.name === DEMO_WORKSPACE.name);
  if (existing) return existing;
  return store.create(DEMO_WORKSPACE.name, {
    about: DEMO_WORKSPACE.about,
    members: [{ userId: DEMO_USER_ID, role: "admin" }],
  });
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A run to record: its summary and the deliverable its result sidecar holds. */
interface SeedRun {
  run: TaskRun;
  output: string;
  /** The deliverable parsed, for a task with an output schema. */
  structured?: unknown;
}

/** Where the seed writes, and how many runs it has minted. */
interface Writer {
  workDir: string;
  wsId: string;
  runs: number;
}

function nextRunId(w: Writer): string {
  w.runs += 1;
  return `run_${w.runs.toString(16).padStart(12, "0")}`;
}

/** Each run's result sidecar, then its index line, as the scheduler writes them. */
function record(w: Writer, taskId: string, runs: readonly SeedRun[]): void {
  for (const { run, output, structured } of runs) {
    saveRunResult(w.workDir, w.wsId, DEMO_USER_ID, taskId, {
      runId: run.id,
      taskId,
      completedAt: run.completedAt ?? run.startedAt,
      output,
      activityLog: [],
      outputFiles: [],
      usage: {
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        iterations: run.iterations,
      },
      ...(structured !== undefined ? { structured } : {}),
      ...(run.error ? { error: run.error } : {}),
    });
    appendRun(w.workDir, w.wsId, DEMO_USER_ID, taskId, run);
  }
}

/** The fields every task carries before its history is folded in. */
function baseTask(wsId: string, id: string, name: string, prompt: string, createdAt: number): Task {
  return {
    id,
    name,
    prompt,
    ownerId: DEMO_USER_ID,
    workspaceId: wsId,
    enabled: true,
    source: "agent",
    createdAt: iso(createdAt),
    updatedAt: iso(createdAt),
    runCount: 0,
    consecutiveErrors: 0,
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
  };
}

/** When each of `count` runs started, oldest first: at a cron's own fire times, else `every` apart. */
function startTimes(fixture: TaskFixture, count: number, now: number): number[] {
  if (count === 0) return [];
  const { schedule } = fixture;
  if (schedule?.type === "cron" && schedule.expression) {
    const fires = new Cron(schedule.expression).previousRuns(count, new Date(now));
    return fires.map((d) => d.getTime()).reverse();
  }
  if (fixture.onceInMs !== undefined) return [now + fixture.onceInMs];
  // The newest run is less than `every` ago, so an interval's next fire is still ahead.
  const sinceLast = Math.min(fixture.every / 2, 3 * HOUR);
  return Array.from({ length: count }, (_, i) => now - (count - 1 - i) * fixture.every - sinceLast);
}

function assessmentOf(
  outcome: Outcome,
  fixture: TaskFixture,
  at: number,
): RunAssessment | undefined {
  const criteria = fixture.criteria ?? [];
  if (criteria.length === 0) return undefined;
  const answer = (passed: boolean, confidence: number, rationale: string) =>
    criteria.map((c) => ({ id: c.id, answer: passed, passed, confidence, rationale }));
  const judged = { assessedAt: iso(at) };
  switch (outcome) {
    case "ok":
      return { ...judged, verdict: "pass", criteria: answer(true, 0.93, "Every field is filled.") };
    case "review":
      return {
        ...judged,
        verdict: "uncertain",
        criteria: answer(true, 0.52, "Probably complete, but one claim could not be checked."),
      };
    case "poor":
      return {
        ...judged,
        verdict: "fail",
        criteria: answer(false, 0.9, "Company size and buyer are missing."),
      };
    default:
      return undefined;
  }
}

/** One run of a saved task, ended as `outcome`. */
function taskRun(
  writer: Writer,
  fixture: TaskFixture,
  outcome: Outcome,
  i: number,
  start: number,
): SeedRun {
  const end = start + 40_000 + ((i * 7919) % 60_000);
  const assessment = assessmentOf(outcome, fixture, end + 2000);
  const input = fixture.inputs?.[i % fixture.inputs.length];
  const base = {
    id: nextRunId(writer),
    taskId: fixture.id,
    startedAt: iso(start),
    completedAt: iso(end),
    trigger: fixture.trigger,
    ...(input !== undefined ? { input } : {}),
  };
  if (outcome === "fail") {
    return {
      output: "",
      run: {
        ...base,
        status: "failure",
        inputTokens: 1200,
        outputTokens: 0,
        toolCalls: 1,
        iterations: 1,
        stopReason: "error",
        costUsd: 0.004,
        error: fixture.error ?? "The run failed.",
      },
    };
  }
  return {
    output: fixture.preview,
    run: {
      ...base,
      status: "success",
      inputTokens: 18_000,
      outputTokens: 900,
      toolCalls: 6,
      iterations: 5,
      stopReason: "complete",
      costUsd: 0.07,
      resultPreview: fixture.preview,
      ...(assessment ? { assessment } : {}),
    },
  };
}

/** Run counters a task keeps, folded from its runs. */
function totalsOf(
  runs: readonly SeedRun[],
): Pick<
  Task,
  | "runCount"
  | "consecutiveErrors"
  | "cumulativeInputTokens"
  | "cumulativeOutputTokens"
  | "lastRunAt"
  | "lastRunStatus"
> {
  let streak = 0;
  for (const { run } of runs) streak = run.status === "failure" ? streak + 1 : 0;
  const last = runs.at(-1)?.run;
  return {
    runCount: runs.length,
    consecutiveErrors: streak,
    cumulativeInputTokens: runs.reduce((n, { run }) => n + run.inputTokens, 0),
    cumulativeOutputTokens: runs.reduce((n, { run }) => n + run.outputTokens, 0),
    ...(last ? { lastRunAt: last.completedAt, lastRunStatus: lastRunStatusOf(last) } : {}),
  };
}

/** A once schedule at `onceAt`, retired as `ran` when that time has passed. */
function onceFields(onceAt: number | undefined, now: number): Partial<Task> {
  if (onceAt === undefined) return {};
  return {
    schedule: { type: "once", at: iso(onceAt) },
    ...(onceAt <= now ? { onceDone: { at: iso(onceAt), outcome: "ran" } } : {}),
  };
}

function seedTask(writer: Writer, fixture: TaskFixture, now: number): void {
  const starts = startTimes(fixture, fixture.outcomes.length, now);
  const runs = fixture.outcomes.map((outcome, i) =>
    taskRun(writer, fixture, outcome, i, starts[i] ?? now),
  );
  const once = onceFields(fixture.onceInMs === undefined ? undefined : now + fixture.onceInMs, now);
  const task: Task = {
    ...baseTask(writer.wsId, fixture.id, fixture.name, fixture.prompt, now - 120 * DAY),
    updatedAt: iso(now - 10 * DAY),
    ...(fixture.schedule ? { schedule: fixture.schedule } : {}),
    ...once,
    enabled: (fixture.enabled ?? true) && !once.onceDone,
    ...(fixture.criteria ? { criteria: fixture.criteria } : {}),
    ...(fixture.inputSchema ? { inputSchema: fixture.inputSchema } : {}),
    ...totalsOf(runs),
    ...(fixture.disabledReason
      ? { disabledAt: iso(now - DAY), disabledReason: fixture.disabledReason }
      : {}),
  };
  const next = task.enabled ? computeNextRunAt(task, now) : null;
  if (next !== null) task.nextRunAt = iso(next);
  saveTask(writer.workDir, writer.wsId, DEMO_USER_ID, task);
  record(writer, fixture.id, runs);
}

function lastRunStatusOf(run: TaskRun): Task["lastRunStatus"] {
  return run.status === "failure" ? "failure" : "success";
}

/** A one-off's id, as `tasks__run` derives it from an idempotency key. */
function oneoffId(seed: string): string {
  return `oneoff-${createHash("sha256").update(seed, "utf-8").digest("hex").slice(0, 20)}`;
}

function oneoffTask(
  writer: Writer,
  id: string,
  fixture: { name?: string; prompt: string; via?: string },
  createdAt: number,
): Task {
  return {
    ...baseTask(writer.wsId, id, fixture.name ?? id, fixture.prompt, createdAt),
    kind: "oneoff",
    ...(fixture.via ? { startedVia: fixture.via } : {}),
  };
}

function seedOneoff(writer: Writer, fixture: OneoffFixture, now: number): void {
  const id = oneoffId(fixture.key);
  const end = now - fixture.agoMs;
  const start = end - 30_000;
  const run: TaskRun = {
    id: nextRunId(writer),
    taskId: id,
    startedAt: iso(start),
    completedAt: iso(end),
    status: fixture.ok ? "success" : "failure",
    inputTokens: 6000,
    outputTokens: fixture.ok ? 400 : 0,
    toolCalls: 2,
    iterations: 2,
    trigger: "manual",
    stopReason: fixture.ok ? "complete" : "error",
    idempotencyKey: fixture.key,
    costUsd: fixture.ok ? 0.03 : 0.002,
    ...(fixture.ok
      ? { resultPreview: fixture.preview }
      : { error: fixture.error ?? "The run failed." }),
  };
  const seeded = [{ run, output: fixture.ok ? fixture.preview : "" }];
  saveTask(writer.workDir, writer.wsId, DEMO_USER_ID, {
    ...oneoffTask(writer, id, fixture, start - MINUTE),
    updatedAt: iso(end),
    ...totalsOf(seeded),
  });
  record(writer, id, seeded);
}

/** What every batch item answers, so the Runs tab's results table has columns. */
const GRADE_SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string" },
    fit: { type: "string", enum: ["strong", "unclear", "weak"] },
    score: { type: "integer", minimum: 0, maximum: 10 },
  },
  required: ["company", "fit", "score"],
};

/** A batch id, `batch_<12 hex>`, derived from its key so a relaunch writes the same one. */
function batchId(key: string): string {
  return `batch_${createHash("sha256").update(key, "utf-8").digest("hex").slice(0, 12)}`;
}

/** One item's run: graded against `GRADE_SCHEMA`, and judged pass or fail. */
function batchItemRun(
  writer: Writer,
  ids: { taskId: string; batchId: string },
  index: number,
  passed: boolean,
  at: { finish: number; costUsd: number },
): SeedRun {
  const input = { company: `Company ${index + 1}` };
  const assessedAt = iso(at.finish + 1000);
  const assessment: RunAssessment = passed
    ? { verdict: "pass", assessedAt }
    : {
        verdict: "fail",
        assessedAt,
        criteria: [
          {
            id: "grounded",
            answer: false,
            passed: false,
            confidence: 0.88,
            rationale: "The grade cites a headcount the sources do not give.",
          },
        ],
      };
  const structured = {
    company: input.company,
    fit: passed ? "strong" : "unclear",
    score: passed ? 6 + (index % 4) : 2 + (index % 3),
  };
  const output = JSON.stringify(structured);
  return {
    output,
    structured,
    run: {
      id: nextRunId(writer),
      taskId: ids.taskId,
      startedAt: iso(at.finish - 25_000),
      completedAt: iso(at.finish),
      status: "success",
      inputTokens: 3000,
      outputTokens: 150,
      toolCalls: 1,
      iterations: 2,
      trigger: "manual",
      stopReason: "complete",
      resultPreview: output,
      outputSchemaValid: true,
      input,
      assessment,
      batchId: ids.batchId,
      batchIndex: index,
      costUsd: at.costUsd,
    },
  };
}

/**
 * A batch, its one-off (named from `batch:<key>`, as an inline batch's is),
 * one recorded run per item that ran, and its items. A batch with items
 * waiting is paused, so the runtime starts none of them at boot.
 */
function seedBatch(writer: Writer, fixture: BatchFixture, now: number): void {
  const taskId = oneoffId(`batch:${fixture.key}`);
  const id = batchId(fixture.key);
  const ran = fixture.pass + fixture.fail;
  const total = ran + (fixture.pending ?? 0);
  const end = now - fixture.agoMs;
  const created = end - 10 * MINUTE;
  const step = Math.floor((end - created) / Math.max(ran, 1));

  const runs: SeedRun[] = [];
  const items: BatchItem[] = [];
  for (let index = 0; index < total; index++) {
    const input = { company: `Company ${index + 1}` };
    if (index >= ran) {
      items.push({ index, input, state: "pending" });
      continue;
    }
    const seeded = batchItemRun(writer, { taskId, batchId: id }, index, index < fixture.pass, {
      finish: created + (index + 1) * step,
      costUsd: fixture.itemCostUsd,
    });
    runs.push(seeded);
    items.push({
      index,
      input,
      state: "done",
      runId: seeded.run.id,
      execution: "completed",
      verdict: seeded.run.assessment?.verdict,
      costUsd: fixture.itemCostUsd,
    });
  }

  saveTask(writer.workDir, writer.wsId, DEMO_USER_ID, {
    ...oneoffTask(writer, taskId, fixture, created - MINUTE),
    outputSchema: GRADE_SCHEMA,
    updatedAt: iso(end),
    ...totalsOf(runs),
  });
  record(writer, taskId, runs);

  const paused = items.some((it) => it.state === "pending");
  writeBatchItems(writer.workDir, writer.wsId, DEMO_USER_ID, id, items);
  const batch: Batch = {
    id,
    taskId,
    workspaceId: writer.wsId,
    ownerId: DEMO_USER_ID,
    items: total,
    concurrency: 8,
    state: paused ? "paused" : "completed",
    ...(paused ? { pause: { reason: "manual", message: "Paused by you.", at: iso(end) } } : {}),
    counts: countItems(items),
    costUsd: runs.length * fixture.itemCostUsd,
    idempotencyKey: fixture.key,
    ...(fixture.name ? { name: fixture.name } : {}),
    ...(fixture.via ? { startedVia: fixture.via } : {}),
    createdAt: iso(created),
    updatedAt: iso(end),
    ...(paused ? {} : { completedAt: iso(end) }),
    createdBy: DEMO_USER_ID,
  };
  saveBatch(writer.workDir, batch);
  saveBatchKey(writer.workDir, writer.wsId, DEMO_USER_ID, fixture.key, id);
}
