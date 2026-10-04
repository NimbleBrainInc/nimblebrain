/**
 * The single sanctioned construction (and parse) site for workspace-partitioned
 * automation paths. Mirrors `src/conversation/paths.ts` and `src/files/paths.ts`:
 * every automation directory is built and parsed here, so the on-disk layout has
 * exactly one definition.
 *
 * The workspace owns the directory: an automation lives under the workspace it
 * fires against, with the owner as a privacy sub-partition. The path is the
 * binding — `Automation.workspaceId` / `Automation.ownerId` are denormalised
 * conveniences; the directory is authoritative.
 *
 *   workspaces/<wsId>/tasks/<ownerId>/<automationId>.json              the definition
 *   workspaces/<wsId>/tasks/<ownerId>/runs/<automationId>/index.jsonl  newest run summaries (the hot window)
 *   workspaces/<wsId>/tasks/<ownerId>/runs/<automationId>/<runId>.result.json  a hot run's deliverable
 *   workspaces/<wsId>/tasks/<ownerId>/runs/<automationId>/archive/<YYYY-MM>/index.jsonl  older summaries, by start month (UTC)
 *   workspaces/<wsId>/tasks/<ownerId>/runs/<automationId>/archive/<YYYY-MM>/<runId>.result.json  their deliverables
 *   workspaces/<wsId>/tasks/<ownerId>/runs/<automationId>/keys/<sha256(key)>.json  an idempotency key and the run it started
 *   workspaces/<wsId>/tasks/<ownerId>/run-tickets/<runId>.json  a requested run's current record, found by run id alone
 *
 * A run's summary and its deliverable move to the archive together, so the
 * hot runs dir holds at most the hot window of sidecars plus `index.jsonl`
 * and `archive/`, and listing it stays bounded however long history grows.
 *
 * An automation run is NOT a conversation: it leaves a *run result* (the final
 * output, the activity log, and refs to any files it wrote in the workspace file
 * store) under its own `runs/` subtree — never a chat under `conversations/`.
 *
 * This file is the only site `check:automation-paths` permits to construct a
 * workspace automations dir.
 */

import { join, sep } from "node:path";

const TASKS_SEGMENT = "tasks";
const LEGACY_SEGMENT = "automations";
const WORKSPACES_SEGMENT = "workspaces";
const RUNS_SEGMENT = "runs";
const TICKETS_SEGMENT = "run-tickets";
const KEYS_SEGMENT = "keys";

/**
 * Automation ids are kebab-case (lowercase alphanumeric segments separated by
 * hyphens), generated from the name. Run ids are `run_<token>`. Both are
 * validated before any path construction to prevent traversal.
 */
const AUTOMATION_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RUN_ID_RE = /^run_[A-Za-z0-9_-]+$/;

export function validateAutomationId(id: string): void {
  if (!AUTOMATION_ID_RE.test(id)) {
    throw new Error(
      `Invalid automation id: ${JSON.stringify(id)}. Must be non-empty kebab-case (lowercase alphanumeric and hyphens).`,
    );
  }
}

export function validateRunId(id: string): void {
  if (!RUN_ID_RE.test(id)) {
    throw new Error(`Invalid run id: ${JSON.stringify(id)}. Must match ${RUN_ID_RE}.`);
  }
}

/**
 * Where a workspace's task storage lived before tasks were named tasks:
 * `{workDir}/workspaces/<wsId>/automations`. Read only by the boot migration
 * (`migrate-storage.ts`), which moves each owner dir under
 * {@link workspaceTasksRoot}.
 */
export function legacyWorkspaceTaskRoot(workDir: string, wsId: string): string {
  return join(workDir, WORKSPACES_SEGMENT, wsId, LEGACY_SEGMENT);
}

/** The directory holding every owner's tasks in one workspace: `{workDir}/workspaces/<wsId>/tasks`. */
export function workspaceTasksRoot(workDir: string, wsId: string): string {
  return join(workDir, WORKSPACES_SEGMENT, wsId, TASKS_SEGMENT);
}

/**
 * Directory holding one owner's automations in one workspace:
 * `{workDir}/workspaces/<wsId>/tasks/<ownerId>`.
 */
export function workspaceTasksDir(workDir: string, wsId: string, ownerId: string): string {
  return join(workspaceTasksRoot(workDir, wsId), ownerId);
}

/** The definition file: `…/tasks/<ownerId>/<automationId>.json`. */
export function automationFilePath(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
): string {
  validateAutomationId(automationId);
  return join(workspaceTasksDir(workDir, wsId, ownerId), `${automationId}.json`);
}

/** The runs dir for one automation: `…/tasks/<ownerId>/runs/<automationId>`. */
export function automationRunsDir(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
): string {
  validateAutomationId(automationId);
  return join(workspaceTasksDir(workDir, wsId, ownerId), RUNS_SEGMENT, automationId);
}

/** The append-only run-summary index: `…/runs/<automationId>/index.jsonl`. */
export function automationRunIndexPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
): string {
  return join(automationRunsDir(workDir, wsId, ownerId, automationId), "index.jsonl");
}

/** An archive month, `YYYY-MM`. */
const ARCHIVE_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const ARCHIVE_SEGMENT = "archive";

/** Whether `name` is an archive month directory name (`YYYY-MM`). */
export function isRunArchiveMonth(name: string): boolean {
  return ARCHIVE_MONTH_RE.test(name);
}

/** The archive root for one automation: `…/runs/<automationId>/archive`. */
export function automationRunArchiveRoot(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
): string {
  return join(automationRunsDir(workDir, wsId, ownerId, automationId), ARCHIVE_SEGMENT);
}

/**
 * One archive month: `…/runs/<automationId>/archive/<YYYY-MM>`, holding the
 * summaries (`index.jsonl`) and deliverables of the runs that started that
 * month (UTC) and rolled out of the hot index.
 */
export function automationRunArchiveDir(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  month: string,
): string {
  if (!isRunArchiveMonth(month)) {
    throw new Error(`Invalid run archive month: ${JSON.stringify(month)}. Must be YYYY-MM.`);
  }
  return join(automationRunArchiveRoot(workDir, wsId, ownerId, automationId), month);
}

/** An archive month's run index: `…/archive/<YYYY-MM>/index.jsonl`. */
export function automationRunSegmentPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  month: string,
): string {
  return join(automationRunArchiveDir(workDir, wsId, ownerId, automationId, month), "index.jsonl");
}

/** An archived run's result sidecar: `…/archive/<YYYY-MM>/<runId>.result.json`. */
export function automationArchivedRunResultPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  month: string,
  runId: string,
): string {
  validateRunId(runId);
  return join(
    automationRunArchiveDir(workDir, wsId, ownerId, automationId, month),
    `${runId}.result.json`,
  );
}

/** A single run's result sidecar: `…/runs/<automationId>/<runId>.result.json`. */
export function automationRunResultPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  runId: string,
): string {
  validateRunId(runId);
  return join(automationRunsDir(workDir, wsId, ownerId, automationId), `${runId}.result.json`);
}

/**
 * A requested run's ticket: `…/tasks/<ownerId>/run-tickets/<runId>.json`.
 * Keyed by run id alone, under the owner, so a task handle (which names only
 * the run) finds its run without knowing the automation, and the owner
 * partition in the path is the ownership check.
 */
export function automationRunTicketPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  runId: string,
): string {
  validateRunId(runId);
  return join(workspaceTasksDir(workDir, wsId, ownerId), TICKETS_SEGMENT, `${runId}.json`);
}

/** A SHA-256 hex digest: the file name an idempotency key is stored under. */
const KEY_DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * Where an idempotency key used on one automation is recorded:
 * `…/runs/<automationId>/keys/<digest>.json`. `digest` is the key's SHA-256,
 * so a caller's key never becomes a path segment.
 */
export function automationIdempotencyKeyPath(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  digest: string,
): string {
  if (!KEY_DIGEST_RE.test(digest)) {
    throw new Error(`Invalid idempotency key digest: ${JSON.stringify(digest)}.`);
  }
  return join(
    automationRunsDir(workDir, wsId, ownerId, automationId),
    KEYS_SEGMENT,
    `${digest}.json`,
  );
}

/** What a parsed automation path resolves to. */
export interface ParsedAutomationPath {
  wsId: string;
  ownerId: string;
}

/**
 * Inverse of the builders: recover `{ wsId, ownerId }` from any path under a
 * `workspaces/<wsId>/tasks/<ownerId>/...` subtree. Returns `null` for a
 * path that isn't one (e.g. a legacy `users/<id>/automations/...` path). The
 * path is the authority; this lets the scheduler recover an automation's
 * workspace + owner without trusting the record's fields.
 */
export function parseAutomationPath(absPath: string): ParsedAutomationPath | null {
  const segments = absPath.split(sep);
  const wsIdx = segments.lastIndexOf(WORKSPACES_SEGMENT);
  if (wsIdx === -1) return null;
  const wsId = segments[wsIdx + 1];
  const autoSeg = segments[wsIdx + 2];
  const ownerId = segments[wsIdx + 3];
  if (!wsId || autoSeg !== TASKS_SEGMENT || !ownerId) return null;
  return { wsId, ownerId };
}
