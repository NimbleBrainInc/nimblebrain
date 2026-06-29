/**
 * Persistence layer for automations — workspace-owned, one file per automation.
 *
 * The workspace owns the directory; the owner is a privacy sub-partition. Every
 * path is constructed via `paths.ts` (the single sanctioned site), so the layout
 * has exactly one definition:
 *
 *   workspaces/<wsId>/automations/<ownerId>/<automationId>.json              the definition (one bare Automation)
 *   workspaces/<wsId>/automations/<ownerId>/runs/<automationId>/index.jsonl  run summaries (append-only, pruned at MAX_RUN_LINES)
 *   workspaces/<wsId>/automations/<ownerId>/runs/<automationId>/<runId>.result.json  the run's deliverable
 *
 * A run is NOT a conversation: it leaves a `AutomationRunResult` sidecar (final
 * output, activity log, output-file refs) under its `runs/` subtree.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  automationFilePath,
  automationRunIndexPath,
  automationRunResultPath,
  automationRunsDir,
  parseAutomationPath,
  validateAutomationId,
  workspaceAutomationsDir,
} from "./paths.ts";
import type { Automation, AutomationRun, AutomationRunResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RUN_LINES = 1000;
const WORKSPACES_SEGMENT = "workspaces";
const AUTOMATIONS_SEGMENT = "automations";
const RUNS_SEGMENT = "runs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function atomicWrite(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmpPath, contents);
  renameSync(tmpPath, filePath);
}

/** The `runs/` root for one owner: `…/automations/<ownerId>/runs`. */
function ownerRunsRoot(workDir: string, wsId: string, ownerId: string): string {
  return join(workspaceAutomationsDir(workDir, wsId, ownerId), RUNS_SEGMENT);
}

// ---------------------------------------------------------------------------
// Definitions — one bare Automation object per `<id>.json`
// ---------------------------------------------------------------------------

/**
 * Load every automation owned by `ownerId` in `wsId`, keyed by id. Reads each
 * `*.json` in the owner dir (skipping the `runs/` subdir). Missing dir → empty
 * map; malformed files are skipped.
 */
export function loadOwnerAutomations(
  workDir: string,
  wsId: string,
  ownerId: string,
): Map<string, Automation> {
  const dir = workspaceAutomationsDir(workDir, wsId, ownerId);
  const map = new Map<string, Automation>();
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return map; // dir not created yet
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const content = readFileSync(join(dir, entry.name), "utf-8");
      const auto = JSON.parse(content) as Automation;
      if (auto && typeof auto.id === "string") map.set(auto.id, auto);
    } catch {
      // skip malformed
    }
  }
  return map;
}

/** Load a single automation, or null if it doesn't exist / is malformed. */
export function loadAutomation(
  workDir: string,
  wsId: string,
  ownerId: string,
  id: string,
): Automation | null {
  const filePath = automationFilePath(workDir, wsId, ownerId, id);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as Automation;
  } catch {
    return null;
  }
}

/** Save a single automation atomically (temp + rename) to its own `<id>.json`. */
export function saveAutomation(
  workDir: string,
  wsId: string,
  ownerId: string,
  automation: Automation,
): void {
  const dir = workspaceAutomationsDir(workDir, wsId, ownerId);
  ensureDir(dir);
  const filePath = automationFilePath(workDir, wsId, ownerId, automation.id);
  atomicWrite(filePath, `${JSON.stringify(automation, null, 2)}\n`);
}

/**
 * Delete only a single automation's `<id>.json`, preserving its run history.
 * This is what the tool/domain delete path uses — the audit trail
 * (`runs/<id>/`) outlives the definition, matching the "Run history preserved"
 * contract.
 */
export function deleteAutomationDefinition(
  workDir: string,
  wsId: string,
  ownerId: string,
  id: string,
): void {
  const filePath = automationFilePath(workDir, wsId, ownerId, id);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // best-effort
  }
}

/**
 * Hard-delete a single automation: its `<id>.json` AND, best-effort, its entire
 * `runs/<id>/` subtree (run index + result sidecars). A full purge — use
 * {@link deleteAutomationDefinition} when run history must be kept.
 */
export function deleteAutomation(workDir: string, wsId: string, ownerId: string, id: string): void {
  deleteAutomationDefinition(workDir, wsId, ownerId, id);
  try {
    const runsDir = automationRunsDir(workDir, wsId, ownerId, id);
    if (existsSync(runsDir)) rmSync(runsDir, { recursive: true, force: true });
  } catch {
    // best-effort — run history removal is not load-bearing
  }
}

/**
 * Load every automation across every workspace + owner. The scheduler's
 * cross-workspace load: walk every `workspaces/<wsId>/automations/<ownerId>`, recover wsId/ownerId
 * authoritatively from the path (`parseAutomationPath`), and backfill those onto
 * each record when the stored value is missing — the directory is the binding.
 */
export function loadAllAutomations(workDir: string): Automation[] {
  const wsRoot = join(workDir, WORKSPACES_SEGMENT);
  const out: Automation[] = [];
  let workspaces: string[];
  try {
    workspaces = readdirSync(wsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out; // workspaces root not created yet
  }
  for (const wsId of workspaces) {
    const autoRoot = join(wsRoot, wsId, AUTOMATIONS_SEGMENT);
    let owners: string[];
    try {
      owners = readdirSync(autoRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue; // no automations in this workspace
    }
    for (const ownerId of owners) {
      // Recover the binding from the path, not the record.
      const parsed = parseAutomationPath(workspaceAutomationsDir(workDir, wsId, ownerId));
      const resolvedWsId = parsed?.wsId ?? wsId;
      const resolvedOwnerId = parsed?.ownerId ?? ownerId;
      for (const auto of loadOwnerAutomations(workDir, resolvedWsId, resolvedOwnerId).values()) {
        if (typeof auto.workspaceId !== "string" || auto.workspaceId.length === 0) {
          auto.workspaceId = resolvedWsId;
        }
        if (typeof auto.ownerId !== "string" || auto.ownerId.length === 0) {
          auto.ownerId = resolvedOwnerId;
        }
        out.push(auto);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runs — runs/<automationId>/index.jsonl (append-only)
// ---------------------------------------------------------------------------

/**
 * Append a run summary to the automation's JSONL index. Creates directories and
 * file if missing; prunes oldest lines when the file exceeds MAX_RUN_LINES.
 */
export function appendRun(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  run: AutomationRun,
): void {
  const dir = automationRunsDir(workDir, wsId, ownerId, automationId);
  ensureDir(dir);
  const filePath = automationRunIndexPath(workDir, wsId, ownerId, automationId);

  appendFileSync(filePath, `${JSON.stringify(run)}\n`);

  // Prune if over limit. Drop the oldest summary lines AND their result
  // sidecars together, so the run dir's total size stays bounded — not just the
  // index (an unpruned pile of `<runId>.result.json` would defeat the cap).
  const content = readFileSync(filePath, "utf-8").trimEnd();
  const lines = content.split("\n");
  if (lines.length > MAX_RUN_LINES) {
    const dropped = lines.slice(0, lines.length - MAX_RUN_LINES);
    const trimmed = lines.slice(lines.length - MAX_RUN_LINES);
    writeFileSync(filePath, `${trimmed.join("\n")}\n`);
    for (const line of dropped) {
      try {
        const old = JSON.parse(line) as AutomationRun;
        if (old.id) {
          unlinkSync(automationRunResultPath(workDir, wsId, ownerId, automationId, old.id));
        }
      } catch {
        // malformed line, or the sidecar is missing/already gone — best-effort
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Read Runs
// ---------------------------------------------------------------------------

export interface ReadRunsOptions {
  limit?: number;
  since?: string; // ISO timestamp
  status?: AutomationRun["status"];
}

/** Read run history for a single automation. Newest first, with optional filters. */
export function readRuns(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  opts?: ReadRunsOptions,
): AutomationRun[] {
  const filePath = automationRunIndexPath(workDir, wsId, ownerId, automationId);
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf-8").trimEnd();
  if (!content) return [];

  const runs: AutomationRun[] = [];
  for (const line of content.split("\n")) {
    try {
      runs.push(JSON.parse(line) as AutomationRun);
    } catch {
      // skip malformed
    }
  }

  runs.reverse(); // newest first
  return applyFilters(runs, opts);
}

/**
 * Read runs across every automation owned by `ownerId` in `wsId`. Newest first,
 * with optional filters.
 */
export function readAllRuns(
  workDir: string,
  wsId: string,
  ownerId: string,
  opts?: ReadRunsOptions,
): AutomationRun[] {
  const runsRoot = ownerRunsRoot(workDir, wsId, ownerId);
  let automationIds: string[];
  try {
    automationIds = readdirSync(runsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  let allRuns: AutomationRun[] = [];
  for (const id of automationIds) {
    try {
      validateAutomationId(id);
    } catch {
      continue; // skip stray dirs that aren't valid automation ids
    }
    const filePath = automationRunIndexPath(workDir, wsId, ownerId, id);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf-8").trimEnd();
    if (!content) continue;
    for (const line of content.split("\n")) {
      try {
        allRuns.push(JSON.parse(line) as AutomationRun);
      } catch {
        // skip malformed
      }
    }
  }

  allRuns.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  allRuns = applyFilters(allRuns, opts);
  return allRuns;
}

function applyFilters(runs: AutomationRun[], opts?: ReadRunsOptions): AutomationRun[] {
  let result = runs;

  if (opts?.since) {
    const sinceMs = new Date(opts.since).getTime();
    result = result.filter((r) => new Date(r.startedAt).getTime() >= sinceMs);
  }

  if (opts?.status) {
    result = result.filter((r) => r.status === opts.status);
  }

  if (opts?.limit !== undefined) {
    result = result.slice(0, opts.limit);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Run results — runs/<automationId>/<runId>.result.json (the deliverable)
// ---------------------------------------------------------------------------

/** Persist a run's full result sidecar atomically (temp + rename). */
export function saveRunResult(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  result: AutomationRunResult,
): void {
  const dir = automationRunsDir(workDir, wsId, ownerId, automationId);
  ensureDir(dir);
  const filePath = automationRunResultPath(workDir, wsId, ownerId, automationId, result.runId);
  atomicWrite(filePath, `${JSON.stringify(result, null, 2)}\n`);
}

/** Read a run's full result sidecar, or null if it doesn't exist / is malformed. */
export function readRunResult(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  runId: string,
): AutomationRunResult | null {
  let filePath: string;
  try {
    filePath = automationRunResultPath(workDir, wsId, ownerId, automationId, runId);
  } catch {
    return null; // invalid run id
  }
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as AutomationRunResult;
  } catch {
    return null;
  }
}
