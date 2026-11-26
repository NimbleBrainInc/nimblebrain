/**
 * The tasks contract's authoring data: everything in the published document
 * except the tools' schemas. `contracts/scripts/emit-contracts.ts` joins it with
 * the schemas (`public.ts` and `private.ts`, gathered in `index.ts`) into
 * `schemas/contracts/tasks/v1/contract.json`. Nothing at runtime imports this
 * file.
 */

import type { ContractMeta } from "../../scripts/contract-source.ts";

export const CONTRACT = {
  $id: "https://schemas.nimblebrain.ai/contracts/tasks/v1/contract.json",
  title: "Tasks contract",
  description:
    "The ai.nimblebrain.tasks contract: its identity, version, cardinality, its tools with " +
    "their visibility, unattended marking, grant marking and schemas, the schemas tools share, " +
    "and the closed list of errors. Every tool error is a tools/call result with isError: true whose " +
    "first text content is JSON {code, error}. A private tool's code is from errors.private. " +
    "A public tool's code, and the answer to a tool name the server does not have, is from " +
    "errors.public, and its error begins with that entry's prefix. Beyond the prefix, error is " +
    "diagnostic. A request refused before any tool runs is the transport's answer and outside " +
    "this list. Normative rules: contracts/tasks/CONTRACT.md in the NimbleBrain repository.",
  contract: "ai.nimblebrain.tasks",
  version: "1.0",
  cardinality: "singleton",
  tools: {
    create: { visibility: "public", unattended: "refused", grant: true },
    update: { visibility: "public", unattended: "refused", grant: true },
    delete: { visibility: "public", unattended: "refused" },
    list: { visibility: "public", unattended: "allowed" },
    status: { visibility: "public", unattended: "allowed" },
    run: { visibility: "public", unattended: "refused", grant: true },
    run_result: { visibility: "public", unattended: "allowed" },
    runs: { visibility: "public", unattended: "allowed" },
    cancel: { visibility: "public", unattended: "refused" },
    upcoming: { visibility: "public", unattended: "allowed" },
    stats: { visibility: "public", unattended: "allowed" },
    run_batch: { visibility: "public", unattended: "refused", grant: true },
    batch: { visibility: "public", unattended: "allowed" },
    batches: { visibility: "public", unattended: "allowed" },
    batch_control: { visibility: "public", unattended: "refused", grant: true },
    due: { visibility: "private", unattended: "refused" },
    begin_run: { visibility: "private", unattended: "refused" },
    end_run: { visibility: "private", unattended: "refused" },
    offer_event: { visibility: "private", unattended: "refused" },
    delete_workspace: { visibility: "private", unattended: "refused" },
  },
  errors: {
    public: [
      {
        code: "task_not_found",
        prefix: "No task with id ",
        meaning:
          "The taskId names no task in the caller's scope: another owner's, another workspace's and a missing one answer alike.",
      },
      {
        code: "task_exists",
        prefix: "A task with id ",
        meaning: "create named a task whose id is already stored in scope. Nothing was written.",
      },
      {
        code: "run_not_found",
        prefix: "No run ",
        meaning: "The runId names no run in the caller's scope.",
      },
      {
        code: "batch_not_found",
        prefix: "Batch not found: ",
        meaning: "The batchId names no batch in the caller's scope.",
      },
      {
        code: "conflict",
        prefix: "Conflict: ",
        meaning:
          "The call contradicts what is stored: an idempotencyKey repeated with another definition, a batch action its state refuses, a budget at or below what is spent. Nothing was written.",
      },
      {
        code: "grant_missing",
        prefix: "No run grant: ",
        meaning:
          "A tool marked grant was called with no grant in its host context. Nothing was written.",
      },
      {
        code: "unattended_refused",
        prefix: "Not available in an unattended run: ",
        meaning:
          'A tool marked unattended "refused" was called with unattended: true in its host context. Nothing was read or written.',
      },
      {
        code: "scope_missing",
        prefix: "[tasks] no ",
        meaning:
          "tools/call reached a public tool with no workspace or no authenticated identity in its scope.",
      },
      {
        code: "invalid_input",
        prefix: "Invalid arguments for ",
        meaning:
          "The arguments do not match the tool's input schema, or a rule the schema cannot state (an unknown timezone, a cron that does not parse, an input that fails the task's inputSchema); the tool name follows the prefix, quoted. Nothing was written.",
      },
      {
        code: "unknown_tool",
        prefix: "Unknown tool ",
        meaning: "No tool by that name, public or private.",
      },
    ],
    private: [
      {
        code: "forbidden",
        meaning:
          "A private tool was called by a principal other than host. Checked before the input and the scope, so the answer reveals nothing about either. Nothing was read or written.",
      },
      {
        code: "invalid_input",
        meaning: "The arguments do not match the tool's input schema. Nothing was written.",
      },
      {
        code: "scope_missing",
        meaning:
          "The call reached the server with no workspace in its scope, or offer_event with no owner. Nothing was read or written.",
      },
      {
        code: "token_stale",
        meaning:
          "begin_run carried a token lower than one already seen for its ref, or end_run a token other than the one whose begin_run received the run's work spec: another claim holds it. Nothing was written.",
      },
      {
        code: "run_not_found",
        meaning: "end_run named a run that begin_run never answered with a work spec in scope.",
      },
      {
        code: "task_not_found",
        meaning: "offer_event named a task absent from the caller's scope.",
      },
      {
        code: "internal_error",
        meaning: "Anything else. The error text is diagnostic only.",
      },
    ],
  },
} as const satisfies ContractMeta;
