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
 *   workspaces/<wsId>/automations/<ownerId>/<automationId>.json              the definition
 *   workspaces/<wsId>/automations/<ownerId>/runs/<automationId>/index.jsonl  run summaries (append-only)
 *   workspaces/<wsId>/automations/<ownerId>/runs/<automationId>/<runId>.result.json  the run's deliverable
 *
 * An automation run is NOT a conversation: it leaves a *run result* (the final
 * output, the activity log, and refs to any files it wrote in the workspace file
 * store) under its own `runs/` subtree — never a chat under `conversations/`.
 *
 * This file is the only site `check:automation-paths` permits to construct a
 * workspace automations dir.
 */

import { join, sep } from "node:path";

const AUTOMATIONS_SEGMENT = "automations";
const WORKSPACES_SEGMENT = "workspaces";
const RUNS_SEGMENT = "runs";

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
 * Directory holding one owner's automations in one workspace:
 * `{workDir}/workspaces/<wsId>/automations/<ownerId>`.
 */
export function workspaceAutomationsDir(workDir: string, wsId: string, ownerId: string): string {
  return join(workDir, WORKSPACES_SEGMENT, wsId, AUTOMATIONS_SEGMENT, ownerId);
}

/** The definition file: `…/automations/<ownerId>/<automationId>.json`. */
export function automationFilePath(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
): string {
  validateAutomationId(automationId);
  return join(workspaceAutomationsDir(workDir, wsId, ownerId), `${automationId}.json`);
}

/** The runs dir for one automation: `…/automations/<ownerId>/runs/<automationId>`. */
export function automationRunsDir(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
): string {
  validateAutomationId(automationId);
  return join(workspaceAutomationsDir(workDir, wsId, ownerId), RUNS_SEGMENT, automationId);
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

/** What a parsed automation path resolves to. */
export interface ParsedAutomationPath {
  wsId: string;
  ownerId: string;
}

/**
 * Inverse of the builders: recover `{ wsId, ownerId }` from any path under a
 * `workspaces/<wsId>/automations/<ownerId>/...` subtree. Returns `null` for a
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
  if (!wsId || autoSeg !== AUTOMATIONS_SEGMENT || !ownerId) return null;
  return { wsId, ownerId };
}
