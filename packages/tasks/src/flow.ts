/**
 * The run flow (CONTRACT.md §5): the private tools the host drives.
 *
 * - **Occurrences.** A timed schedule's next occurrence is `nextRunAt`, anchored on the
 *   `now` of the first `due` after the schedule was saved or changed; its ref and key are
 *   `s:<task uid>:<epoch ms>`, so a changed time is a new key and the old one is skipped
 *   when claimed. Every other run (asked for with `run`, a batch item, a pending event
 *   occurrence) is a queued run record; its ref is `r:<run id>` and its key adds its
 *   `notBefore`.
 * - **Fencing is per ref** (`state.fences`): the highest token seen and what it was
 *   answered. A repeat of that token answers the same; a lower one is `token_stale`; a
 *   higher one after a run was answered records that run interrupted, provisionally, and
 *   answers skip with `interrupted`. `end_run` is accepted once, from the token whose
 *   claim received the work spec.
 * - **The clock is the host's.** Every decision here is taken on the `now`/`until` of the
 *   call or on an outcome's `startedAt`/`endedAt`; nothing reads a clock.
 */

import { batchAccount, batchRunEnded, batchRunRefused, pumpBatch, sharingOf } from "./batches.ts";
import { privateError, sharedSchemaError } from "./contract.ts";
import type {
  Batch,
  FenceAnswer,
  Notice,
  OfferedEvent,
  RunAnswer,
  RunRecord,
  TaskDef,
} from "./model.ts";
import {
  allTasks,
  blobNames,
  clearDisableState,
  disable,
  findTask,
  newRunId,
  runningRunOf,
  taskByUid,
} from "./records.ts";
import {
  type DisableCause,
  disabledNotice,
  endedUnstarted,
  executionOf,
  labelOf,
  type Outcome,
  poorResultNotice,
  recordOutcome,
  resultOfRecord,
  runFailedNotice,
} from "./runs.ts";
import {
  addUsage,
  budgetAccounts,
  budgetSpent,
  DEFAULT_EVENT_DEBOUNCE_MS,
  DEFAULT_EVENT_MAX_FIRES_PER_HOUR,
  FIRE_WINDOW_MS,
  isTimed,
  MAX_CONSECUTIVE_ERRORS,
  MAX_CONSECUTIVE_TRANSIENT_ERRORS,
  MAX_EVENTS_PER_RUN,
  matchAdmits,
  nextAfterRun,
  nextOccurrence,
  ONCE_GRACE_MS,
  setNextRunAt,
} from "./schedule.ts";
import type { Tx } from "./store.ts";

const iso = (ms: number) => new Date(ms).toISOString();

// ── due ──────────────────────────────────────────────────────────────────

interface Occurrence {
  key: string;
  ref: string;
  notBefore?: string;
}

const DUE_PAGE = 500;

/** `due`: the occurrences owed in the workspace at or before `until`, judged at `now`. */
export function due(
  tx: Tx,
  args: { now: string; until: string; cursor?: string; limit?: number },
  retentionMs: number,
): { occurrences: Occurrence[]; cancel: string[]; nextCursor: string | null } {
  const now = Date.parse(args.now);
  const until = Date.parse(args.until);
  if (args.cursor === undefined) prune(tx, now, retentionMs);
  for (const task of allTasks(tx.ws.state)) anchor(tx, task, now);
  const all = [...scheduledOccurrences(tx, until), ...requestedOccurrences(tx, until)].sort(
    (a, b) => sortKey(a).localeCompare(sortKey(b)),
  );
  const after = args.cursor === undefined ? undefined : decodeCursor(args.cursor);
  const rest = after === undefined ? all : all.filter((o) => sortKey(o) > after);
  const limit = args.limit ?? DUE_PAGE;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return {
    occurrences: page,
    cancel: cancelList(tx),
    nextCursor: rest.length > limit && last ? encodeCursor(sortKey(last)) : null,
  };
}

/** Occurrences sort by when they are due (at once first), then by key. */
function sortKey(o: Occurrence): string {
  return `${o.notBefore ?? "0000"}\u0000${o.key}`;
}

function encodeCursor(position: string): string {
  return Buffer.from(position, "utf-8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf-8");
}

/**
 * Place a timed schedule saved or changed since the last `due` on this `now`, stamp the
 * definition's first host instant, and judge a once's lateness where it is produced: a once
 * not yet listed whose `notBefore` is more than its grace before this `now` was missed while
 * the host was down (recorded skipped: missed) and is never listed. Once listed, it is the
 * host's to run however long its queue holds it; nothing judges it late again.
 */
function anchor(tx: Tx, task: TaskDef, now: number): void {
  if (!task.seenAt) task.seenAt = iso(now);
  if (!task.enabled || task.inFlight || !isTimed(task.schedule) || task.onceDone) return;
  if (task.nextRunAt === undefined) setNextRunAt(task, nextOccurrence(task, now));
  const schedule = task.schedule;
  if (!schedule || !("at" in schedule) || task.nextRunAt === undefined) return;
  if (task.onceListed === task.nextRunAt) return;
  if (now - Date.parse(task.nextRunAt) > ONCE_GRACE_MS) retireMissed(tx, task, now);
}

function retireMissed(tx: Tx, task: TaskDef, now: number): Notice[] {
  const at = task.schedule && "at" in task.schedule ? task.schedule.at : iso(now);
  const run = newRun(task, "scheduled", iso(now));
  endUnstarted(
    tx,
    run,
    "skipped",
    `Missed its one time at ${at}: it is more than its grace past it.`,
    iso(now),
  );
  task.enabled = false;
  task.onceDone = { at: iso(now), outcome: "missed" };
  task.disabledAt = iso(now);
  task.disabledReason = `Missed its one time at ${at}`;
  delete task.nextRunAt;
  delete task.onceListed;
  return [];
}

function scheduledOccurrences(tx: Tx, until: number): Occurrence[] {
  const out: Occurrence[] = [];
  for (const task of allTasks(tx.ws.state)) {
    if (!task.enabled || task.inFlight || task.onceDone || task.nextRunAt === undefined) continue;
    if (!isTimed(task.schedule)) continue;
    const at = Date.parse(task.nextRunAt);
    if (at > until) continue;
    const ref = `s:${task.uid}:${at}`;
    out.push({ key: ref, ref, notBefore: iso(at) });
    // Produced: from here a once is owed to the host's queue, never judged late again.
    if (task.schedule && "at" in task.schedule) task.onceListed = task.nextRunAt;
  }
  return out;
}

function requestedOccurrences(tx: Tx, until: number): Occurrence[] {
  const out: Occurrence[] = [];
  for (const run of Object.values(tx.ws.state.open)) {
    if (run.status !== "queued") continue;
    const notBefore = run.notBefore ? Date.parse(run.notBefore) : undefined;
    if (notBefore !== undefined && notBefore > until) continue;
    const ref = `r:${run.id}`;
    out.push(
      notBefore === undefined
        ? { key: ref, ref }
        : { key: `${ref}@${notBefore}`, ref, notBefore: iso(notBefore) },
    );
  }
  return out;
}

/** Begun runs asked to stop whose `end_run` has not landed. */
function cancelList(tx: Tx): string[] {
  return Object.values(tx.ws.state.open)
    .filter((r) => r.cancelRequested && r.status === "running")
    .map((r) => r.id)
    .sort();
}

// ── Retention ────────────────────────────────────────────────────────────

/**
 * Remove the data of runs that ended more than the retention period before `now`: their
 * records, results, answers, inputs, fences and idempotency keys; skip fences and event
 * dedup entries as old; and one-offs with nothing left. Never an open run, a run of a
 * batch that is not settled, or a one-off a batch names.
 */
function prune(tx: Tx, now: number, retentionMs: number): void {
  const cutoff = now - retentionMs;
  const { state } = tx.ws;
  const unsettled = new Set(
    Object.values(state.batches)
      .filter((b) => b.state === "running" || b.state === "paused")
      .map((b) => b.id),
  );
  const expired = [...tx.ws.ended.values()].filter(
    (r) =>
      Date.parse(r.completedAt ?? r.startedAt ?? "") < cutoff &&
      !(r.batchId && unsettled.has(r.batchId)),
  );
  if (expired.length > 0) dropRuns(tx, new Set(expired.map((r) => r.id)));
  for (const [ref, fence] of Object.entries(state.fences)) {
    if (fence.answer.decision === "skip" && Date.parse(fence.at) < cutoff) delete state.fences[ref];
  }
  for (const task of allTasks(state)) pruneEventsSeen(task, cutoff);
  pruneOneoffs(tx, cutoff);
}

function dropRuns(tx: Tx, ids: Set<string>): void {
  const { state } = tx.ws;
  tx.dropEnded(ids);
  for (const id of ids) {
    tx.dropBlob(blobNames.input(id));
    tx.dropBlob(blobNames.answer(id));
    tx.dropBlob(blobNames.result(id));
  }
  for (const [ref, fence] of Object.entries(state.fences)) {
    if (fence.answer.decision === "run" && ids.has(fence.answer.runId)) delete state.fences[ref];
  }
  for (const [name, entry] of Object.entries(state.keys)) {
    if (entry.runId && ids.has(entry.runId)) delete state.keys[name];
  }
}

function pruneEventsSeen(task: TaskDef, cutoff: number): void {
  if (!task.eventsSeen) return;
  for (const [key, at] of Object.entries(task.eventsSeen)) {
    if (Date.parse(at) < cutoff) delete task.eventsSeen[key];
  }
  if (Object.keys(task.eventsSeen).length === 0) delete task.eventsSeen;
}

function pruneOneoffs(tx: Tx, cutoff: number): void {
  const { state } = tx.ws;
  const named = new Set(Object.values(state.batches).map((b) => b.taskUid));
  const runUids = new Set(
    [...Object.values(state.open), ...tx.ws.ended.values()].map((r) => r.taskUid),
  );
  for (const task of allTasks(state)) {
    if (task.kind !== "oneoff" || named.has(task.uid) || runUids.has(task.uid)) continue;
    if (!task.seenAt || Date.parse(task.seenAt) >= cutoff) continue;
    delete state.tasks[task.ownerId]?.[task.id];
    if (Object.keys(state.tasks[task.ownerId] ?? {}).length === 0) delete state.tasks[task.ownerId];
  }
}

// ── begin_run ────────────────────────────────────────────────────────────

export type BeginAnswer =
  | { decision: "run"; runId: string; grant: string; work: Record<string, unknown> }
  | {
      decision: "skip";
      reason: string;
      interrupted?: { runId: string; token: number };
      notices?: Notice[];
    };

/** `begin_run`: a claimed occurrence, answered skip or run, fenced per ref. */
export function beginRun(
  tx: Tx,
  args: { ref: string; attempt: number; token: number; now: string },
): BeginAnswer {
  const { state } = tx.ws;
  const fence = Object.hasOwn(state.fences, args.ref) ? state.fences[args.ref] : undefined;
  if (fence && args.token < fence.token) {
    throw privateError(
      "token_stale",
      `token ${args.token} is below ${fence.token}, already seen for this ref`,
    );
  }
  if (fence && args.token === fence.token) return answerOf(tx, fence.answer);
  // The run an earlier claim received, whether this ref's last answer was that run or an
  // interrupted skip naming it: every higher claim reports it until its `end_run` lands.
  const held =
    fence?.answer.decision === "run"
      ? { runId: fence.answer.runId, token: fence.token }
      : fence?.answer.interrupted;
  if (held) return interrupt(tx, args, held.token, held.runId);
  const answer = decide(tx, args.ref, args.token, Date.parse(args.now));
  state.fences[args.ref] = { token: args.token, answer: fenceAnswer(answer), at: args.now };
  return answer;
}

function fenceAnswer(answer: BeginAnswer): FenceAnswer {
  if (answer.decision === "run") return { decision: "run", runId: answer.runId };
  return answer;
}

/** The stored answer, repeated: a run's grant and work spec are read back as they were given. */
function answerOf(tx: Tx, answer: FenceAnswer): BeginAnswer {
  if (answer.decision === "skip") return answer;
  const given = tx.readBlob<RunAnswer>(blobNames.answer(answer.runId));
  if (!given) throw new Error(`the answer to run ${answer.runId} is missing`);
  return { decision: "run", runId: answer.runId, grant: given.grant, work: given.work };
}

/**
 * A later claim of a ref whose run an earlier claim received: never that run again. While
 * the run's `end_run` has not landed it is recorded interrupted, provisionally, and the
 * answer names it with the token that received its work, on this claim and every later one.
 */
function interrupt(
  tx: Tx,
  args: { ref: string; token: number; now: string },
  earlier: number,
  runId: string,
): BeginAnswer {
  const run = Object.hasOwn(tx.ws.state.open, runId) ? tx.ws.state.open[runId] : undefined;
  const answer: BeginAnswer = run
    ? {
        decision: "skip",
        reason: "an earlier claim received this run; it is recorded interrupted",
        interrupted: { runId, token: earlier },
      }
    : { decision: "skip", reason: "an earlier claim received this run, and it has ended" };
  if (run && !run.interruptedAt) {
    run.interruptedAt = args.now;
    run.error =
      "interrupted: an earlier claim began this run and never reported its end; it was not run again";
    run.transient = true;
  }
  tx.ws.state.fences[args.ref] = { token: args.token, answer, at: args.now };
  return answer;
}

/** Decide a first claim of a ref (or a higher claim after a skip) from the records. */
function decide(tx: Tx, ref: string, token: number, now: number): BeginAnswer {
  if (ref.startsWith("s:")) return decideScheduled(tx, ref, token, now);
  if (ref.startsWith("r:")) return decideRequested(tx, ref, ref.slice(2), token, now);
  return { decision: "skip", reason: "no occurrence has this ref" };
}

function decideScheduled(tx: Tx, ref: string, token: number, now: number): BeginAnswer {
  const [, uid = "", atText = ""] = ref.split(":");
  const at = Number(atText);
  const task = taskByUid(tx.ws.state, uid);
  if (!task) return { decision: "skip", reason: "the task was deleted" };
  if (task.nextRunAt === undefined || Date.parse(task.nextRunAt) !== at || task.inFlight) {
    return { decision: "skip", reason: "the occurrence is no longer owed: the schedule moved on" };
  }
  const refusal = scheduledRefusal(tx, task, now);
  if (refusal) {
    const run = newRun(task, "scheduled", iso(now));
    endUnstarted(tx, run, "skipped", refusal, iso(now));
    advanceAfterSkip(task, now);
    return { decision: "skip", reason: refusal };
  }
  // A once's lateness was judged when `due` produced this occurrence (`anchor`): a claim
  // runs it however long the host's queue held it.
  const once = task.schedule && "at" in task.schedule ? task.schedule.at : undefined;
  const run = newRun(task, "scheduled", iso(now));
  if (once !== undefined) run.onceAt = once;
  task.inFlight = run.id;
  return start(tx, task, run, ref, token, now);
}

/** Why a due occurrence of `task` does not run now, or null. */
function scheduledRefusal(tx: Tx, task: TaskDef, now: number): string | null {
  if (!task.enabled) return "Disabled while waiting to run";
  if (runningRunOf(tx.ws.state, task.uid)) return "Already running: the task has a run in flight";
  return budgetSpent(task, now);
}

/** The schedule's next occurrence after one that was skipped at `now`. */
function advanceAfterSkip(task: TaskDef, now: number): void {
  const schedule = task.schedule;
  if (!schedule || "at" in schedule) return;
  if ("intervalMs" in schedule) setNextRunAt(task, now + schedule.intervalMs);
  else setNextRunAt(task, nextOccurrence(task, now));
}

function decideRequested(
  tx: Tx,
  ref: string,
  runId: string,
  token: number,
  now: number,
): BeginAnswer {
  const { state } = tx.ws;
  const run = Object.hasOwn(state.open, runId) ? state.open[runId] : undefined;
  if (run?.status !== "queued") {
    const ended = tx.ws.ended.get(runId);
    return {
      decision: "skip",
      reason: ended ? `the run is ${executionOf(ended)}` : "the run is no longer owed",
    };
  }
  const task = taskByUid(state, run.taskUid);
  const batch = run.batchId ? state.batches[run.batchId] : undefined;
  const refusal = requestedRefusal(tx, run, task, now);
  if (refusal || !task) {
    const reason = refusal ?? "The task was deleted";
    const notices = batch ? refuseBatchRun(tx, batch, run, reason, now) : [];
    endUnstarted(tx, run, "skipped", reason, iso(now));
    return { decision: "skip", reason, ...(notices.length > 0 ? { notices } : {}) };
  }
  if (batch) run.sharedBy = sharingOf(batch);
  return start(tx, task, run, ref, token, now);
}

function requestedRefusal(
  tx: Tx,
  run: RunRecord,
  task: TaskDef | undefined,
  now: number,
): string | null {
  if (!task) return "The task was deleted";
  if (run.trigger === "event" && (!task.enabled || !task.schedule || !("match" in task.schedule))) {
    return "The task was disabled or rescheduled before its events ran";
  }
  if (!run.batchId && runningRunOf(tx.ws.state, task.uid))
    return "Already running: the task has a run in flight";
  return budgetSpent(task, now);
}

function refuseBatchRun(
  tx: Tx,
  batch: Batch,
  run: RunRecord,
  reason: string,
  now: number,
): Notice[] {
  const kind = reason.startsWith("Token budget") ? "budget" : "unavailable";
  return batchRunRefused(tx, batch, run, kind, reason, iso(now));
}

/** A fresh run record of `task`. */
function newRun(task: TaskDef, trigger: RunRecord["trigger"], at: string): RunRecord {
  return {
    id: newRunId(),
    taskId: task.id,
    taskUid: task.uid,
    ownerId: task.ownerId,
    trigger,
    status: "queued",
    requestedAt: at,
    inputTokens: 0,
    outputTokens: 0,
    iterations: 0,
    toolCalls: 0,
  };
}

/** End a run that never started, with a result of its record. */
function endUnstarted(
  tx: Tx,
  run: RunRecord,
  status: "skipped" | "cancelled",
  reason: string,
  at: string,
): void {
  const ended = endedUnstarted(run, status, reason, at);
  tx.putBlob(blobNames.result(run.id), resultOfRecord(ended));
  tx.endRun(ended);
}

/** Begin the run: record it running, keep the answer, and answer with the grant and the work spec. */
function start(
  tx: Tx,
  task: TaskDef,
  run: RunRecord,
  ref: string,
  token: number,
  now: number,
): BeginAnswer {
  run.status = "running";
  run.startedAt = iso(now);
  run.ref = ref;
  run.token = token;
  tx.ws.state.open[run.id] = run;
  const batch = run.batchId ? tx.ws.state.batches[run.batchId] : undefined;
  if (batch && run.batchIndex !== undefined) {
    const item = batch.items[run.batchIndex];
    if (item?.runId === run.id) batch.items[run.batchIndex] = { ...item, state: "running" };
  }
  const work = workSpec(tx, task, run, now, batch);
  const problem = sharedSchemaError("work_spec", work);
  if (problem) throw new Error(`the work spec of run ${run.id} fails its schema: ${problem}`);
  tx.putBlob(blobNames.answer(run.id), { grant: task.grant, work } satisfies RunAnswer);
  return { decision: "run", runId: run.id, grant: task.grant, work };
}

/** The work spec of `run` (CONTRACT.md §7): data and limits, never prompt text around them. */
function workSpec(
  tx: Tx,
  task: TaskDef,
  run: RunRecord,
  now: number,
  batch: Batch | undefined,
): Record<string, unknown> {
  const input = inputOf(tx, run);
  const limits = Object.fromEntries(
    (["maxIterations", "maxInputTokens", "maxRunDurationMs"] as const)
      .filter((k) => task[k] !== undefined)
      .map((k) => [k, task[k]]),
  );
  const accounts = [
    ...budgetAccounts(task, now, run.sharedBy),
    ...(batch && batchAccount(batch) ? [batchAccount(batch)] : []),
  ];
  const fields: Record<string, unknown> = {
    input,
    notes: run.events ? eventNotes(run.events) : undefined,
    outputSchema: task.outputSchema,
    allowedTools: task.allowedTools,
    skills: task.skills,
    limits: Object.keys(limits).length > 0 ? limits : undefined,
    model: task.model,
    thinkingEffort: task.thinkingEffort,
    spendAccounts: accounts.length > 0 ? accounts : undefined,
    exclusiveKey: run.batchId ? undefined : `task:${task.uid}`,
    trigger: run.trigger,
  };
  const work: Record<string, unknown> = { kind: "agent", prompt: task.prompt };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) work[k] = v;
  return work;
}

function inputOf(tx: Tx, run: RunRecord): unknown {
  if (run.batchId !== undefined && run.batchIndex !== undefined) {
    return tx.readBlob<unknown[]>(blobNames.batch(run.batchId))?.[run.batchIndex];
  }
  return run.hasInput ? tx.readBlob<{ input: unknown }>(blobNames.input(run.id))?.input : undefined;
}

/** The most notes a work spec carries, and the longest. */
const MAX_NOTES = 8;
const MAX_NOTE_CHARS = 8000;
/** The longest of an event's text fields a note keeps. */
const EVENT_FIELD_CHARS = 1200;

/** An occurrence's events as notes: JSON arrays of their presentation, packed into at most 8. */
export function eventNotes(events: OfferedEvent[]): string[] {
  const cut = (s: string | undefined) =>
    s && s.length > EVENT_FIELD_CHARS ? `${s.slice(0, EVENT_FIELD_CHARS)}…` : s;
  const rows = events.map((e) =>
    JSON.stringify({ ...e, title: cut(e.title), subject: cut(e.subject), body: cut(e.body) }),
  );
  const notes: string[][] = [[]];
  for (const row of rows) {
    const current = notes[notes.length - 1] as string[];
    const size = current.reduce((n, r) => n + r.length + 1, 2) + row.length;
    if (current.length > 0 && size > MAX_NOTE_CHARS) notes.push([row]);
    else current.push(row);
  }
  const packed = notes.map((n) => `[${n.join(",")}]`).filter((n) => n.length <= MAX_NOTE_CHARS);
  return packed.slice(0, MAX_NOTES);
}

// ── end_run ──────────────────────────────────────────────────────────────

/** `end_run`: record how a run ended, once; answers the notices to deliver. */
export function endRun(
  tx: Tx,
  args: { runId: string; token: number; outcome: Outcome },
): { notices: Notice[] } {
  const { state } = tx.ws;
  const open = Object.hasOwn(state.open, args.runId) ? state.open[args.runId] : undefined;
  const run = open ?? tx.ws.ended.get(args.runId);
  if (!run || run.token === undefined) {
    throw privateError(
      "run_not_found",
      `begin_run never answered run ${args.runId} with a work spec`,
    );
  }
  if (run.token !== args.token) {
    throw privateError("token_stale", `run ${args.runId} was received by another claim's token`);
  }
  if (!open) return { notices: run.notices ?? [] };
  const given = tx.readBlob<RunAnswer>(blobNames.answer(run.id));
  const outputSchema = given?.work.outputSchema as Record<string, unknown> | undefined;
  const { record, result } = recordOutcome(run, args.outcome, outputSchema);
  const notices = applyEnd(tx, record, args.outcome);
  if (notices.length > 0) record.notices = notices;
  tx.putBlob(blobNames.result(run.id), result);
  tx.endRun(record);
  tx.changed();
  return { notices };
}

/** What an ended run does to its task and its batch. */
function applyEnd(tx: Tx, run: RunRecord, outcome: Outcome): Notice[] {
  const task = taskByUid(tx.ws.state, run.taskUid);
  const notices: Notice[] = [];
  if (task) notices.push(...applyToTask(task, run, outcome));
  const batch = run.batchId ? tx.ws.state.batches[run.batchId] : undefined;
  if (batch) notices.push(...batchRunEnded(tx, batch, run, outcome.endedAt));
  return notices;
}

function applyToTask(task: TaskDef, run: RunRecord, outcome: Outcome): Notice[] {
  const ended = Date.parse(outcome.endedAt);
  if (task.inFlight === run.id) delete task.inFlight;
  task.runCount++;
  addUsage(task, Date.parse(outcome.startedAt), run.inputTokens, run.outputTokens);
  const notices = run.batchId === undefined ? applyToSchedule(task, run, outcome, ended) : [];
  const spent = budgetSpent(task, ended) ?? budgetStop(task, run);
  if (spent && disable(task, spent, outcome.endedAt))
    notices.push(disabledNotice(run.id, task.ownerId, "budget", run.id));
  return notices;
}

/** A stop by one of the task's own budget accounts, by a run that held it alone, spends the window. */
function budgetStop(task: TaskDef, run: RunRecord): string | null {
  const own = run.spendAccountId?.startsWith(`task-budget:${task.uid}@`) === true;
  return own && (run.sharedBy ?? 1) <= 1 && run.inputTokens + run.outputTokens > 0
    ? "Token budget reached: a run was stopped by it"
    : null;
}

/** A non-batch run's effect on its task: last run, failure streak, notices, next occurrence. */
function applyToSchedule(task: TaskDef, run: RunRecord, outcome: Outcome, ended: number): Notice[] {
  task.lastRunAt = run.startedAt;
  task.lastRunLabel = labelOf(run);
  const notices: Notice[] = [];
  const code = outcome.error?.code;
  if (
    outcome.stopReason === "not_started" &&
    (code === "grant_invalid" || code === "membership_revoked")
  ) {
    if (
      disable(
        task,
        `Its run grant no longer admits runs (${code}). Save it again to re-stamp it.`,
        outcome.endedAt,
      )
    ) {
      notices.push(disabledNotice(run.id, task.ownerId, "grant", run.id));
    }
  } else {
    notices.push(...applyStreak(task, run, outcome.endedAt));
  }
  if (run.assessment?.verdict === "fail") notices.push(poorResultNotice(run));
  if (
    run.trigger === "scheduled" &&
    run.onceAt !== undefined &&
    task.schedule &&
    "at" in task.schedule &&
    task.schedule.at === run.onceAt
  ) {
    retireOnce(task, run);
  } else if (isTimed(task.schedule) && !(task.schedule && "at" in task.schedule)) {
    setNextRunAt(task, nextAfterRun(task, ended));
  }
  return notices;
}

function retireOnce(task: TaskDef, run: RunRecord): void {
  delete task.onceListed;
  task.enabled = false;
  task.onceDone = { at: run.startedAt ?? "", outcome: "ran" };
  task.disabledAt = run.completedAt;
  task.disabledReason = `Ran once at ${run.startedAt}`;
  delete task.nextRunAt;
}

/** Count the run toward the failure streak; the notice it raises, if any. */
function applyStreak(task: TaskDef, run: RunRecord, at: string): Notice[] {
  if (run.status === "success" || run.status === "degraded") {
    clearDisableState(task);
    return [];
  }
  if (run.status !== "failure" && run.status !== "timeout") return [];
  task.consecutiveErrors++;
  if (run.transient) task.transientErrors = (task.transientErrors ?? 0) + 1;
  const counted = task.consecutiveErrors - (task.transientErrors ?? 0);
  const cause: DisableCause | null =
    counted >= MAX_CONSECUTIVE_ERRORS || task.consecutiveErrors >= MAX_CONSECUTIVE_TRANSIENT_ERRORS
      ? "failures"
      : null;
  if (
    cause &&
    disable(task, `Auto-disabled after ${task.consecutiveErrors} consecutive failures.`, at)
  ) {
    return [disabledNotice(run.id, task.ownerId, cause, run.id)];
  }
  if (executionOf(run) === "failed" && !task.failureNoticeRunId) {
    task.failureNoticeRunId = run.id;
    return [runFailedNotice(run)];
  }
  return [];
}

// ── offer_event ──────────────────────────────────────────────────────────

export type EventAnswer =
  | { accepted: true; notices?: Notice[] }
  | {
      accepted: false;
      outcome: "skipped" | "denied";
      classification: string;
      reason: string;
      notices?: Notice[];
    };

/** `offer_event`: take a routed notification into the task's pending event occurrence. */
export function offerEvent(
  tx: Tx,
  ownerId: string,
  args: { taskId: string; event: OfferedEvent; now: string },
): EventAnswer {
  const task = findTask(tx.ws.state, ownerId, args.taskId);
  if (!task)
    throw privateError(
      "task_not_found",
      `no task "${args.taskId}" of this owner in this workspace`,
    );
  const refused = eventRefusal(task, args.event);
  if (refused) return refused;
  const seenKey = `${args.event.source}\u0000${args.event.id}`;
  if (task.eventsSeen?.[seenKey] !== undefined) return { accepted: true };
  const now = Date.parse(args.now);
  const pending = pendingEventRun(tx, task);
  if (pending) {
    joinPending(pending, args.event, now);
  } else {
    const ceiling = fireCeiling(tx, task, now);
    if (ceiling) return ceiling;
    const run = newEventRun(task, args.event, now);
    tx.ws.state.open[run.id] = run;
  }
  task.eventsSeen = { ...task.eventsSeen, [seenKey]: args.now };
  tx.changed();
  return { accepted: true };
}

function eventRefusal(task: TaskDef, event: OfferedEvent): EventAnswer | null {
  const schedule = task.schedule;
  if (!schedule || !("match" in schedule)) {
    return {
      accepted: false,
      outcome: "denied",
      classification: "not_event_scheduled",
      reason: "the task does not run on events; give it an event schedule",
    };
  }
  if (!task.enabled) {
    return {
      accepted: false,
      outcome: "skipped",
      classification: "task_disabled",
      reason: "the task is disabled",
    };
  }
  if (!matchAdmits(schedule.match, event)) {
    return {
      accepted: false,
      outcome: "skipped",
      classification: "match_declined",
      reason: "the task's event match does not admit this notification",
    };
  }
  return null;
}

function pendingEventRun(tx: Tx, task: TaskDef): RunRecord | undefined {
  return Object.values(tx.ws.state.open).find(
    (r) =>
      r.taskUid === task.uid &&
      r.trigger === "event" &&
      r.status === "queued" &&
      (r.events?.length ?? 0) < MAX_EVENTS_PER_RUN,
  );
}

/** Join the pending occurrence; a full one is due at once (a new key, so it runs promptly). */
function joinPending(run: RunRecord, event: OfferedEvent, now: number): void {
  run.events = [...(run.events ?? []), event];
  if (run.events.length >= MAX_EVENTS_PER_RUN && run.notBefore && Date.parse(run.notBefore) > now) {
    run.notBefore = iso(now);
  }
}

function newEventRun(task: TaskDef, event: OfferedEvent, now: number): RunRecord {
  const schedule = task.schedule && "match" in task.schedule ? task.schedule : undefined;
  const run = newRun(task, "event", iso(now));
  run.notBefore = iso(now + (schedule?.debounceMs ?? DEFAULT_EVENT_DEBOUNCE_MS));
  run.events = [event];
  return run;
}

/** A new occurrence that would pass the fire ceiling disables the task and refuses the event. */
function fireCeiling(tx: Tx, task: TaskDef, now: number): EventAnswer | null {
  const schedule = task.schedule && "match" in task.schedule ? task.schedule : undefined;
  const max = schedule?.maxFiresPerHour ?? DEFAULT_EVENT_MAX_FIRES_PER_HOUR;
  if (firesSince(tx, task, now - FIRE_WINDOW_MS) < max) return null;
  const reason =
    `Auto-disabled after firing ${max} times from events within an hour, its ceiling. ` +
    "Re-enable it once the loop is broken.";
  const notices = disable(task, reason, iso(now))
    ? [disabledNotice(`${task.uid}:${now}`, task.ownerId, "fire_ceiling")]
    : [];
  tx.changed();
  return {
    accepted: false,
    outcome: "denied",
    classification: "event_fire_ceiling",
    reason,
    notices,
  };
}

/** Event runs of the task begun at or after `since` (and any still pending), which count as fires. */
export function firesSince(tx: Tx | { ws: Tx["ws"] }, task: TaskDef, since: number): number {
  const runs = [...Object.values(tx.ws.state.open), ...tx.ws.ended.values()];
  return runs.filter(
    (r) =>
      r.taskUid === task.uid &&
      r.trigger === "event" &&
      r.status !== "skipped" &&
      (r.status === "queued" || Date.parse(r.startedAt ?? "") >= since),
  ).length;
}

// ── delete_workspace ─────────────────────────────────────────────────────

/** What a purge removes, counted before the workspace's storage goes. */
export function workspaceCounts(ws: Tx["ws"]): { tasks: number; runs: number; batches: number } {
  return {
    tasks: allTasks(ws.state).length,
    runs: Object.keys(ws.state.open).length + ws.ended.size,
    batches: Object.keys(ws.state.batches).length,
  };
}

export { pumpBatch };
