/**
 * The public tools (CONTRACT.md §4): definitions, runs asked for, reads, and
 * batches. Each is called with its arguments already checked against its
 * input schema, walled to one workspace and owner, inside one store
 * transaction. The grant-marked ones (`create`, `update`, `run`, `run_batch`,
 * `batch_control`) re-stamp the definition they name with the call's grant
 * (§9). Instants here are this plugin's own clock, used only to stamp records
 * and to render reads (§6).
 */

import { createHash } from "node:crypto";
import { toolsOf } from "../../server-sdk/src/index.ts";
import { type BatchAction, batchRunCancelled, controlBatch, pumpBatch } from "./batches.ts";
import {
  batchNotFound,
  CONTRACT,
  conflict,
  invalidInput,
  publicError,
  runNotFound,
  taskNotFound,
} from "./contract.ts";
import { MAX_RUN_INPUT_BYTES, runInputProblem, schemaProblem } from "./json-schema.ts";
import type { Batch, DefinitionFields, RunRecord, Schedule, TaskDef } from "./model.ts";
import {
  activeRunOf,
  allTasks,
  blobNames,
  clearDisableState,
  findBatch,
  findRun,
  findTask,
  keyName,
  newBatchId,
  newRunId,
  newUid,
  putTask,
  removeTask,
} from "./records.ts";
import { isEnded, labelOf, runView } from "./runs.ts";
import { scheduleProblem } from "./schedule.ts";
import type { Tx } from "./store.ts";
import { batchView, type ResultFilter, resultsPage, taskRecord, taskSummary } from "./views.ts";

/** What a public call is walled to, and the grant the host stamped. */
export interface Caller {
  workspaceId: string;
  ownerId: string;
  grant?: string;
}

type Args = Record<string, unknown>;
// biome-ignore lint/suspicious/noExplicitAny: each input was checked against its contract schema
type Checked = any;

const wallNow = () => Date.now();
const stamp = () => new Date().toISOString();

const DEFINITION_FIELDS = [
  "description",
  "skills",
  "model",
  "thinkingEffort",
  "allowedTools",
  "maxIterations",
  "maxInputTokens",
  "maxRunDurationMs",
  "tokenBudget",
  "inputSchema",
  "outputSchema",
] as const satisfies readonly (keyof DefinitionFields)[];

/** A task's id: its name in kebab case. */
export function toKebabCase(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** How a host names this contract's tools to agents (CONTRACT.md §3), and so in `allowedTools`. */
const HOST_PREFIX = "tasks__";

/** This contract's public tools by the host's names, and whether a run may call each (§10). */
const HOST_TOOLS = toolsOf(CONTRACT, "public").map((tool) => ({
  name: `${HOST_PREFIX}${tool}`,
  refused: CONTRACT.tools[tool]?.unattended === "refused",
}));

/** Whether `name` matches an `allowedTools` entry, where `*` is any run of characters. */
function globMatches(entry: string, name: string): boolean {
  if (!entry.includes("*")) return entry === name;
  const source = entry.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${source}$`).test(name);
}

/**
 * The `allowedTools` entries that name only tools a run can never call: under the
 * host's names for this contract's tools, they match some, every one refused
 * unattended (§4, §10). The rest of the list is opaque: only the host matches it.
 */
export function unrunnableTools(allowedTools: readonly string[] | undefined): string[] {
  return (allowedTools ?? []).filter((entry) => {
    if (!entry.startsWith(HOST_PREFIX)) return false;
    const matched = HOST_TOOLS.filter((t) => globMatches(entry, t.name));
    return matched.length > 0 && matched.every((t) => t.refused);
  });
}

/** Why a list naming `entries` is refused, in words the person reads in chat. */
function unrunnableProblem(entries: string[]): string {
  const named = entries.map((e) => `"${e}"`).join(", ");
  return (
    `allowedTools names ${named}, which a scheduled run can never call: runs cannot create, ` +
    "edit, delete, run or cancel scheduled tasks. Remove " +
    (entries.length === 1 ? "it" : "them") +
    `, and leave that step out of the instructions; "${HOST_PREFIX}*" still lets a run read tasks.`
  );
}

/**
 * Refuse an `allowedTools` list that names only tools a run can never call. An
 * update checks the list it is given, so a task saved before keeps changing.
 */
function checkAllowedTools(tool: string, allowedTools: unknown): void {
  if (!Array.isArray(allowedTools)) return;
  const unrunnable = unrunnableTools(allowedTools as string[]);
  if (unrunnable.length > 0) throw invalidInput(tool, unrunnableProblem(unrunnable));
}

/**
 * Refuse a once at or before the latest `now` the host gave (`hostNow`): the host's clock
 * has passed it, so it could only be recorded missed. A time after that instant is judged
 * on the next `due`, which runs it within its grace (CONTRACT.md §6).
 */
function checkOnceAhead(tx: Tx, tool: string, schedule: Schedule | undefined): void {
  const seen = tx.ws.state.hostNow;
  if (!schedule || !("at" in schedule) || seen === undefined) return;
  if (Date.parse(schedule.at) > Date.parse(seen)) return;
  throw invalidInput(
    tool,
    `the one-time schedule's at (${schedule.at}) has already passed by the host's clock ` +
      `(${seen}). Give a later time, or use run to run it now.`,
  );
}

/** Refuse a definition the schema cannot judge: an unplaceable schedule, a schema that does not compile, an empty prompt with no skills. */
function checkDefinition(
  tool: string,
  task: Pick<TaskDef, "schedule" | "prompt" | "skills" | "inputSchema" | "outputSchema">,
): void {
  const problem =
    (task.schedule ? scheduleProblem(task.schedule) : null) ??
    (task.inputSchema ? schemaProblem(task.inputSchema, "inputSchema") : null) ??
    (task.outputSchema ? schemaProblem(task.outputSchema, "outputSchema") : null) ??
    (task.prompt === "" && !task.skills?.length
      ? "the prompt (body) may be empty only with skills"
      : null);
  if (problem) throw invalidInput(tool, problem);
}

/** The grant a grant-marked call carries; the server's call order checked it is there. */
function grantOf(caller: Caller): string {
  if (!caller.grant)
    throw publicError("grant_missing", "the host stamped no run grant on this call.");
  return caller.grant;
}

function requireTask(tx: Tx, caller: Caller, taskId: string): TaskDef {
  const task = findTask(tx.ws.state, caller.ownerId, taskId);
  if (!task) throw taskNotFound(taskId);
  return task;
}

function newTask(
  caller: Caller,
  fields: Partial<TaskDef> & Pick<TaskDef, "id" | "name" | "prompt" | "kind">,
): TaskDef {
  const now = stamp();
  return {
    uid: newUid(),
    ownerId: caller.ownerId,
    enabled: true,
    grant: grantOf(caller),
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    consecutiveErrors: 0,
    usage: { window: "", input: 0, output: 0 },
    ...fields,
  };
}

// ── create / update / delete ─────────────────────────────────────────────

export function create(tx: Tx, caller: Caller, args: Checked) {
  const manifest = args.manifest as Args;
  const id = toKebabCase(String(manifest.name));
  if (!id) throw invalidInput("create", "the name has no letters or digits to make an id from");
  const fields = Object.fromEntries(
    DEFINITION_FIELDS.filter((f) => manifest[f] !== undefined).map((f) => [f, manifest[f]]),
  );
  const task = newTask(caller, {
    ...fields,
    id,
    name: String(manifest.name),
    prompt: String(args.body),
    kind: (manifest.kind as TaskDef["kind"] | undefined) ?? "saved",
    enabled: manifest.enabled !== false,
    ...(manifest.schedule ? { schedule: manifest.schedule as Schedule } : {}),
  });
  checkAllowedTools("create", task.allowedTools);
  checkDefinition("create", task);
  checkOnceAhead(tx, "create", task.schedule);
  if (findTask(tx.ws.state, caller.ownerId, id)) {
    throw publicError(
      "task_exists",
      `${id} already exists. Change it with update, or give another name.`,
    );
  }
  putTask(tx.ws.state, task);
  tx.changed();
  return {
    task: taskRecord(task, caller.workspaceId, wallNow()),
    message: `Task "${task.name}" created (id: ${id}).`,
  };
}

/** Apply a manifest patch: `null` clears a field, an omitted one is kept. Whether anything was given. */
function applyPatch(task: TaskDef, manifest: Args): boolean {
  let changed = false;
  // biome-ignore lint/plugin/double-cast: a patch writes through a string-keyed view of the same task
  const record = task as unknown as Record<string, unknown>;
  for (const field of [...DEFINITION_FIELDS, "schedule"] as const) {
    if (!(field in manifest)) continue;
    if (manifest[field] === null) delete record[field];
    else record[field] = manifest[field];
    changed = true;
  }
  return changed;
}

export function update(tx: Tx, caller: Caller, args: Checked) {
  const task = requireTask(tx, caller, args.taskId);
  const manifest = (args.manifest ?? {}) as Args;
  const before = { budget: JSON.stringify(task.tokenBudget), retired: task.onceDone !== undefined };
  checkAllowedTools("update", manifest.allowedTools);
  let updated = applyPatch(task, manifest);
  if (args.body !== undefined) {
    task.prompt = args.body;
    updated = true;
  }
  checkDefinition("update", task);
  if (manifest.schedule) checkOnceAhead(tx, "update", task.schedule);
  if ("schedule" in manifest) rescheduled(task, manifest, before.retired);
  if (manifest.enabled !== undefined) setEnabled(task, manifest.enabled === true);
  if (JSON.stringify(task.tokenBudget) !== before.budget)
    task.usage = { window: "", input: 0, output: 0 };
  task.grant = grantOf(caller);
  task.updatedAt = stamp();
  delete task.seenAt;
  tx.changed();
  return {
    task: taskRecord(task, caller.workspaceId, wallNow()),
    updated: updated || manifest.enabled !== undefined,
    message: `Task "${task.name}" updated.`,
  };
}

/** A new schedule (or none): placed in time on the next `due`; a new `at` re-arms a retired once. */
function rescheduled(task: TaskDef, manifest: Args, wasRetired: boolean): void {
  delete task.nextRunAt;
  delete task.onceDone;
  delete task.onceListed;
  if (wasRetired && task.schedule && "at" in task.schedule && manifest.enabled !== false) {
    task.enabled = true;
    clearDisableState(task);
  }
}

function setEnabled(task: TaskDef, enabled: boolean): void {
  if (enabled && task.onceDone) {
    throw conflict(
      `"${task.id}" ran its one time already; give it a new \`at\` to run it again, or use run.`,
    );
  }
  if (enabled && !task.enabled) clearDisableState(task);
  task.enabled = enabled;
}

export function remove(tx: Tx, caller: Caller, args: Checked) {
  const task = findTask(tx.ws.state, caller.ownerId, args.taskId);
  if (!task)
    return { deleted: false, id: args.taskId, message: `No task "${args.taskId}" to delete.` };
  removeTask(tx.ws.state, task);
  tx.changed();
  return {
    deleted: true,
    id: task.id,
    message: `Task "${task.name}" deleted. Its run history stays.`,
  };
}

// ── list / status ────────────────────────────────────────────────────────

const LIST_DEFAULT = 100;

export function list(tx: Tx, caller: Caller, args: Checked) {
  const kind = args.kind ?? "saved";
  const tasks = Object.values(tx.ws.state.tasks[caller.ownerId] ?? {})
    .filter(
      (t) =>
        (args.enabled === undefined || t.enabled === args.enabled) &&
        (kind === "all" || t.kind === kind),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const after = args.cursor ? Buffer.from(args.cursor, "base64url").toString("utf-8") : undefined;
  const rest = after === undefined ? tasks : tasks.filter((t) => t.id > after);
  const limit = args.limit ?? LIST_DEFAULT;
  const page = rest.slice(0, limit);
  const hasMore = rest.length > limit;
  const last = page[page.length - 1];
  return {
    tasks: page.map(taskSummary),
    nextCursor: hasMore && last ? Buffer.from(last.id, "utf-8").toString("base64url") : null,
    total: tasks.length,
    hasMore,
    ...(hasMore
      ? {
          truncated: `Showing ${page.length} of ${tasks.length}; pass nextCursor as cursor for the rest.`,
        }
      : {}),
  };
}

/** The owner's runs, open and ended, of one task or all, newest first. */
function ownerRuns(tx: Tx, caller: Caller, taskId?: string): RunRecord[] {
  return [...Object.values(tx.ws.state.open), ...tx.ws.ended.values()]
    .filter((r) => r.ownerId === caller.ownerId && (taskId === undefined || r.taskId === taskId))
    .sort(newestFirst);
}

function startOf(run: RunRecord): string {
  return run.startedAt ?? run.completedAt ?? run.requestedAt ?? "";
}

function newestFirst(a: RunRecord, b: RunRecord): number {
  const at = startOf(b).localeCompare(startOf(a));
  return at !== 0 ? at : b.id.localeCompare(a.id);
}

export function status(tx: Tx, caller: Caller, args: Checked) {
  const task = requireTask(tx, caller, args.taskId);
  const limit = args.limit ?? 5;
  const runs = ownerRuns(tx, caller, task.id)
    .filter((r) => r.taskUid === task.uid)
    .slice(0, limit);
  return {
    task: taskRecord(task, caller.workspaceId, wallNow()),
    recentRuns: runs.map((r) => runView(r)),
  };
}

// ── run / run_result / runs / cancel ─────────────────────────────────────

/** The fields of a one-off that make up its definition, for comparing two of them. */
function canonical(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(normalize);
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    return Object.fromEntries(
      entries.sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)]),
    );
  };
  return JSON.stringify(normalize(value)) ?? "null";
}

function definitionOf(task: Pick<TaskDef, "prompt"> & DefinitionFields): string {
  return canonical({
    prompt: task.prompt,
    ...Object.fromEntries(
      DEFINITION_FIELDS.filter((f) => f !== "description").map((f) => [f, task[f]]),
    ),
  });
}

/**
 * The one-off an inline definition names: found by the id its idempotency key derives
 * (a repeat with another definition is `conflict`), else created.
 */
function ensureOneoff(
  tx: Tx,
  caller: Caller,
  tool: string,
  def: Args,
  seed: string | undefined,
): TaskDef {
  const manifest = (def.manifest ?? {}) as Args;
  const { name, ...fields } = manifest;
  const token = seed
    ? createHash("sha256").update(seed, "utf-8").digest("hex").slice(0, 20)
    : newUid();
  const id = `oneoff-${token}`;
  const candidate = newTask(caller, {
    ...(fields as DefinitionFields),
    id,
    name: (name as string | undefined) ?? id,
    prompt: (def.body as string | undefined) ?? "",
    kind: "oneoff",
  });
  checkAllowedTools(tool, candidate.allowedTools);
  checkDefinition(tool, candidate);
  const existing = findTask(tx.ws.state, caller.ownerId, id);
  if (!existing) {
    putTask(tx.ws.state, candidate);
    return candidate;
  }
  if (definitionOf(existing) !== definitionOf(candidate)) {
    throw conflict(
      "idempotencyKey reused with a different definition. Use a new key for a new definition.",
    );
  }
  return existing;
}

/** The task a `run` or `run_batch` names: `taskId` or an inline `definition`, exactly one. */
function targetOf(tx: Tx, caller: Caller, tool: string, args: Checked): TaskDef {
  if ((args.taskId === undefined) === (args.definition === undefined)) {
    throw invalidInput(
      tool,
      "give `taskId` (a task to run) or `definition` (a one-off), not both and not neither",
    );
  }
  if (args.taskId !== undefined) return requireTask(tx, caller, args.taskId);
  const seed = args.idempotencyKey === undefined ? undefined : `${tool}:${args.idempotencyKey}`;
  return ensureOneoff(tx, caller, tool, args.definition, seed);
}

export function run(tx: Tx, caller: Caller, args: Checked) {
  const task = targetOf(tx, caller, "run", args);
  const problem = runInputProblem(task.inputSchema, args.input);
  if (problem) throw invalidInput("run", problem);
  task.grant = grantOf(caller);
  const keyed =
    args.idempotencyKey === undefined
      ? undefined
      : keyName(caller.ownerId, "run", args.idempotencyKey);
  const existing = keyed ? tx.ws.state.keys[keyed] : undefined;
  if (existing?.runId && findRun(tx.ws, existing.runId, caller.ownerId)) {
    if (existing.taskId !== task.id)
      throw conflict("idempotencyKey already asked for a run of another task.");
    return { runId: existing.runId, taskId: task.id, existing: true };
  }
  const active = activeRunOf(tx.ws.state, task.uid);
  if (active) {
    const where = active.status === "running" ? "running" : "queued";
    throw conflict(
      `"${task.id}" already has a run ${where} (${active.id}). Follow it with run_result, ` +
        "or cancel it to ask for a new one.",
    );
  }
  const record: RunRecord = {
    id: newRunId(),
    taskId: task.id,
    taskUid: task.uid,
    ownerId: caller.ownerId,
    trigger: "manual",
    status: "queued",
    requestedAt: stamp(),
    inputTokens: 0,
    outputTokens: 0,
    iterations: 0,
    toolCalls: 0,
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
  };
  if (args.input !== undefined) {
    record.hasInput = true;
    tx.putBlob(blobNames.input(record.id), { input: args.input });
  }
  tx.ws.state.open[record.id] = record;
  if (keyed) tx.ws.state.keys[keyed] = { runId: record.id, taskId: task.id };
  tx.changed();
  return { runId: record.id, taskId: task.id };
}

export function runResult(tx: Tx, caller: Caller, args: Checked) {
  const run = findRun(tx.ws, args.runId, caller.ownerId);
  if (!run) throw runNotFound(args.runId);
  const input = inputOfRun(tx, run);
  const view = runView(run, input);
  if (!isEnded(run)) {
    return {
      run: view,
      message: `Run "${run.id}" is ${view.execution}; call run_result again until it has ended, or stop it with cancel.`,
    };
  }
  const result = tx.readBlob<Record<string, unknown>>(blobNames.result(run.id));
  return { run: view, ...(result ? { result } : {}) };
}

function inputOfRun(tx: Tx, run: RunRecord): unknown {
  if (run.batchId !== undefined && run.batchIndex !== undefined) {
    return tx.readBlob<unknown[]>(blobNames.batch(run.batchId))?.[run.batchIndex];
  }
  return run.hasInput ? tx.readBlob<{ input: unknown }>(blobNames.input(run.id))?.input : undefined;
}

const RUNS_DEFAULT = 20;

function runsFilter(args: Checked): (r: RunRecord) => boolean {
  return (r) =>
    isEnded(r) &&
    (args.label === undefined || labelOf(r) === args.label) &&
    (args.verdict === undefined || r.assessment?.verdict === args.verdict) &&
    (args.since === undefined || Date.parse(startOf(r)) >= Date.parse(args.since)) &&
    !(args.excludeBatchRuns === true && r.batchId !== undefined);
}

export function runs(tx: Tx, caller: Caller, args: Checked) {
  const all = ownerRuns(tx, caller, args.taskId).filter(runsFilter(args));
  const after = args.cursor
    ? (JSON.parse(Buffer.from(args.cursor, "base64url").toString("utf-8")) as [string, string])
    : undefined;
  const rest = after
    ? all.filter((r) => startOf(r) < after[0] || (startOf(r) === after[0] && r.id < after[1]))
    : all;
  const limit = args.limit ?? RUNS_DEFAULT;
  const page = rest.slice(0, limit);
  const last = page[page.length - 1];
  return {
    runs: page.map((r) => runView(r)),
    nextCursor:
      rest.length > limit && last
        ? Buffer.from(JSON.stringify([startOf(last), last.id])).toString("base64url")
        : null,
    total: page.length,
  };
}

export function cancel(tx: Tx, caller: Caller, args: Checked) {
  const run = findRun(tx.ws, args.runId, caller.ownerId);
  if (!run) throw runNotFound(args.runId);
  const answer = (cancelled: boolean, message: string) => ({
    cancelled,
    runId: run.id,
    taskId: run.taskId,
    message,
  });
  const open = tx.ws.state.open[run.id];
  if (!open || isEnded(open))
    return answer(false, `Run "${run.id}" has ended; there is nothing to cancel.`);
  if (open.status === "queued") {
    const ended: RunRecord = {
      ...open,
      status: "cancelled",
      error: "Cancelled while queued",
      completedAt: stamp(),
    };
    delete ended.events;
    tx.endRun(ended);
    const batch = ended.batchId ? tx.ws.state.batches[ended.batchId] : undefined;
    if (batch) batchRunCancelled(tx, batch, ended, stamp());
    tx.changed();
    return answer(true, `Run "${run.id}" cancelled before it started.`);
  }
  open.cancelRequested = true;
  tx.changed();
  return answer(true, `Run "${run.id}" is being stopped; it ends cancelled.`);
}

// ── run_batch / batch / batches / batch_control ──────────────────────────

const MAX_BATCH_INPUT_BYTES = 16 * 1024 * 1024;
const BAD_ITEMS_NAMED = 5;
/** The batch's concurrency when the caller names none. */
export const DEFAULT_BATCH_CONCURRENCY = 2;

/** Refuse the batch when any item cannot be a run's input, naming the first few. */
function checkItems(task: TaskDef, items: unknown[]): void {
  const total = Buffer.byteLength(JSON.stringify(items) ?? "", "utf-8");
  if (total > MAX_BATCH_INPUT_BYTES) {
    throw invalidInput(
      "run_batch",
      `the items are ${total} bytes serialized; a batch's items may be at most ${MAX_BATCH_INPUT_BYTES} together`,
    );
  }
  const bad: string[] = [];
  items.forEach((input, index) => {
    const problem = runInputProblem(task.inputSchema, input);
    if (problem && bad.length < BAD_ITEMS_NAMED) bad.push(`item ${index}: ${problem}`);
  });
  if (bad.length > 0) throw invalidInput("run_batch", `nothing was created; ${bad.join("; ")}`);
}

export function runBatch(tx: Tx, caller: Caller, args: Checked) {
  const task = targetOf(tx, caller, "run_batch", args);
  task.grant = grantOf(caller);
  const keyed =
    args.idempotencyKey === undefined
      ? undefined
      : keyName(caller.ownerId, "run_batch", args.idempotencyKey);
  const existing = keyed ? tx.ws.state.keys[keyed] : undefined;
  const found = existing?.batchId
    ? findBatch(tx.ws.state, caller.ownerId, existing.batchId)
    : undefined;
  if (found) {
    if (found.taskUid !== task.uid || found.items.length !== args.items.length) {
      throw conflict(`idempotencyKey already made batch "${found.id}" of another task or size.`);
    }
    return {
      batch: batchView(found),
      existing: true,
      message: `An earlier call with this key made batch "${found.id}".`,
    };
  }
  checkItems(task, args.items);
  if (args.stopWhen && !task.outputSchema) {
    throw invalidInput(
      "run_batch",
      "stopWhen needs runs that are assessed, but the task has no outputSchema",
    );
  }
  const now = stamp();
  const batch: Batch = {
    id: newBatchId(),
    taskId: task.id,
    taskUid: task.uid,
    ownerId: caller.ownerId,
    concurrency: args.concurrency ?? DEFAULT_BATCH_CONCURRENCY,
    state: "running",
    createdAt: now,
    updatedAt: now,
    items: args.items.map(() => ({ state: "pending" as const })),
    ...(args.definition?.manifest?.name ? { name: args.definition.manifest.name } : {}),
    ...(args.budgetUsd !== undefined ? { budgetUsd: args.budgetUsd } : {}),
    ...(args.stopWhen ? { stopWhen: args.stopWhen } : {}),
    ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
  };
  tx.putBlob(blobNames.batch(batch.id), args.items);
  tx.ws.state.batches[batch.id] = batch;
  if (keyed) tx.ws.state.keys[keyed] = { batchId: batch.id, taskId: task.id };
  pumpBatch(tx, batch, now);
  tx.changed();
  return {
    batch: batchView(batch),
    existing: false,
    message: `Batch "${batch.id}" started: ${batch.items.length} item(s), at most ${batch.concurrency} at once.`,
  };
}

function requireBatch(tx: Tx, caller: Caller, batchId: string): Batch {
  const batch = findBatch(tx.ws.state, caller.ownerId, batchId);
  if (!batch) throw batchNotFound(batchId);
  return batch;
}

export function batch(tx: Tx, caller: Caller, args: Checked) {
  const found = requireBatch(tx, caller, args.batchId);
  const wantResults =
    args.results === true ||
    args.filter !== undefined ||
    args.cursor !== undefined ||
    args.limit !== undefined ||
    args.output !== undefined;
  if (!wantResults) return { batch: batchView(found) };
  const inputs = tx.readBlob<unknown[]>(blobNames.batch(found.id)) ?? [];
  const page = resultsPage(
    found,
    inputs,
    {
      filter: args.filter as ResultFilter | undefined,
      start: args.cursor ?? 0,
      limit: args.limit ?? 50,
      full: args.output === "full",
    },
    (runId) => tx.readBlob<{ structured?: unknown }>(blobNames.result(runId))?.structured,
  );
  return {
    batch: batchView(found),
    results: page.results,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
  };
}

export function batches(tx: Tx, caller: Caller, args: Checked) {
  const found = Object.values(tx.ws.state.batches)
    .filter(
      (b) =>
        b.ownerId === caller.ownerId &&
        (args.taskId === undefined || b.taskId === args.taskId) &&
        (args.state === undefined || b.state === args.state),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, args.limit ?? 20);
  return { batches: found.map(batchView) };
}

export function batchControl(tx: Tx, caller: Caller, args: Checked) {
  const found = requireBatch(tx, caller, args.batchId);
  const grant = grantOf(caller);
  const task = allTasks(tx.ws.state).find((t) => t.uid === found.taskUid);
  if (task) task.grant = grant;
  const result = controlBatch(tx, found, args.action as BatchAction, args.budgetUsd, stamp());
  return { batch: batchView(found), affected: result.affected, message: result.message };
}

export { MAX_RUN_INPUT_BYTES };
