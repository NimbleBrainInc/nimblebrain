/**
 * The tasks contract as this plugin serves it: the published document (tools,
 * visibility, unattended and grant marking, schemas, errors), read once, and
 * each tool's input validator compiled from it. Nothing here restates the
 * document; the descriptions are this server's own words.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  type ContractDocument,
  publicErrorPrefix,
  ToolCallError,
} from "../../server-sdk/src/index.ts";

/** Where the document lives in this repository: the published schema tree. */
const CONTRACT_PATH = resolve(import.meta.dir, "../../../schemas/contracts/tasks/v1/contract.json");

export const CONTRACT = JSON.parse(readFileSync(CONTRACT_PATH, "utf-8")) as ContractDocument;

// Formats are asserted: an instant without an offset names no one instant.
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(CONTRACT);

const validators = new Map<string, ValidateFunction>();

function validatorOf(ref: string | undefined, what: string): ValidateFunction {
  const cached = validators.get(what);
  if (cached) return cached;
  const validate = ref ? ajv.getSchema(new URL(ref, CONTRACT.$id).href) : undefined;
  if (!validate) throw new Error(`the contract has no schema for ${what}`);
  validators.set(what, validate);
  return validate;
}

/** Check a tool's arguments against its input schema; the error text when they fail. */
export function inputError(tool: string, args: unknown): string | null {
  const validate = validatorOf(CONTRACT.tools[tool]?.input.$ref, `${tool} input`);
  return validate(args) ? null : ajv.errorsText(validate.errors);
}

/** Check a value against a shared `$defs` entry (used to hold this server's own answers). */
export function sharedSchemaError(name: string, value: unknown): string | null {
  const validate = validatorOf(`#/$defs/${name}`, name);
  return validate(value) ? null : ajv.errorsText(validate.errors);
}

/** A public tool's failure: its code, and text beginning with the code's prefix. */
export function publicError(code: string, rest: string): ToolCallError {
  return new ToolCallError(code, `${publicErrorPrefix(CONTRACT, code)}${rest}`);
}

/** A private tool's failure. */
export function privateError(code: string, message: string): ToolCallError {
  return new ToolCallError(code, message);
}

export const taskNotFound = (taskId: string) =>
  publicError("task_not_found", `${taskId}. list returns your tasks and their ids.`);
export const runNotFound = (runId: string) => publicError("run_not_found", `${runId} in scope.`);
export const batchNotFound = (batchId: string) => publicError("batch_not_found", batchId);
export const conflict = (message: string) => publicError("conflict", message);
export const invalidInput = (tool: string, message: string) =>
  publicError("invalid_input", `"${tool}": ${message}`);

/** Each tool's description in `tools/list`. */
export const DESCRIPTIONS: Record<string, string> = {
  create:
    "Save a task: a prompt (`body`) and a manifest with its name (the id is derived from it), an optional schedule (exactly one of {cron, timezone}, {at}, {intervalMs}, or {match} for routed notifications), and run-time policy. Refuses a name already taken. Runs act as you, unattended.",
  update:
    "Patch a task by `taskId`: give only the fields to change; `null` clears one. A new schedule is placed in time on the next check. `enabled: true` turns a disabled task back on.",
  delete: "Delete a task and its run grant. Its run history stays readable with runs.",
  list: "One page of your tasks in this workspace (saved ones by default), with their schedule in words, last run label and next run. Follow `nextCursor`.",
  status:
    "One task: its whole definition, state (enabled, next run, failure streak, budget window) and its most recent runs.",
  run: "Ask for a run of a task (`taskId`) or of an inline one-off (`definition`), with an optional JSON `input`. Answers at once with the `runId`; read it with run_result, stop it with cancel. An `idempotencyKey` makes a repeat answer the first run.",
  run_result:
    "One run by id, whatever its state: `run.execution` says whether it has ended (queued and running are answers, not errors; call again). An ended run carries its whole result: the deliverable, structured output, activity log, files and usage.",
  runs: "Ended runs, newest first, filtered by task, label, verdict or start time. Follow `nextCursor` with the same filters.",
  cancel:
    "Cancel one run by id: a queued run is cancelled at once; a running one is stopped by the host and ends cancelled.",
  upcoming:
    "What is running and queued now, the coming fires of timed schedules within `days`, and the tasks events fire with their fires in the last hour.",
  stats:
    "Per task, runs started since an instant (default 30 days), pass and fail verdicts, pass rate, cost, and the newest runs.",
  run_batch:
    "Run one task (or an inline one-off) over many inputs, at most `concurrency` at once, under an optional `budgetUsd` and `stopWhen` rule. Every item is checked first: one bad item refuses the whole batch.",
  batch:
    "One batch: its state and counts, and with `results` (or a filter, cursor or limit) a page of its item results.",
  batches: "Your batches, newest first, filtered by task or state.",
  batch_control:
    "Pause, resume, cancel, or re-run a batch's failed items (`rerun_failed`). `budgetUsd` with resume or rerun_failed sets a new budget for a batch that is not running.",
  due: "The occurrences due in the workspace at or before `until`, judged at `now`, for the host to enqueue; and `cancel`, the begun runs to stop.",
  begin_run: "A claimed occurrence: skip it, or the run to execute, its grant and its work spec.",
  end_run: "Record how a run ended; answers the notices to deliver.",
  offer_event: "Offer a routed notification to an event-scheduled task.",
  delete_workspace:
    "Purge every owner's tasks, grants, runs, batches and keys in the workspace. Idempotent.",
};
