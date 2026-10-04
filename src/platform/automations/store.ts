/**
 * Persistence layer for automations — workspace-owned, one file per automation.
 *
 * The workspace owns the directory; the owner is a privacy sub-partition. Every
 * path is constructed via `paths.ts` (the single sanctioned site), so the layout
 * has exactly one definition:
 *
 *   workspaces/<wsId>/automations/<ownerId>/<automationId>.json              the definition (one bare Automation)
 *   workspaces/<wsId>/automations/<ownerId>/runs/<automationId>/index.jsonl  the newest MAX_RUN_LINES run summaries (hot window)
 *   workspaces/<wsId>/automations/<ownerId>/runs/<automationId>/index-YYYY-MM.jsonl  older summaries, by start month (UTC)
 *   workspaces/<wsId>/automations/<ownerId>/runs/<automationId>/<runId>.result.json  the run's deliverable
 *
 * Run history is kept indefinitely. The hot index stays bounded so every
 * append, recent-run read, and event fire check reads a small file; lines past
 * the window roll into month segments, which are read only by a paged read
 * that asks for older runs ({@link readRunsPage}).
 *
 * A run is NOT a conversation: it leaves a `AutomationRunResult` sidecar (final
 * output, activity log, output-file refs) under its `runs/` subtree.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ensureWorkspaceDir } from "../../workspace/context.ts";
import {
  automationFilePath,
  automationRunIndexPath,
  automationRunResultPath,
  automationRunSegmentPath,
  automationRunsDir,
  parseAutomationPath,
  parseRunSegmentFileName,
  validateAutomationId,
  workspaceAutomationsDir,
} from "./paths.ts";
import type { Automation, AutomationRun, AutomationRunResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Run summaries the hot `index.jsonl` holds; older ones roll into month segments. */
export const MAX_RUN_LINES = 1000;
const WORKSPACES_SEGMENT = "workspaces";
const AUTOMATIONS_SEGMENT = "automations";
const RUNS_SEGMENT = "runs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function atomicWrite(filePath: string, contents: string): void {
  const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(tmpPath, contents);
  renameSync(tmpPath, filePath);
}

/** The `runs/` root for one owner: `…/automations/<ownerId>/runs`. */
function ownerRunsRoot(workDir: string, wsId: string, ownerId: string): string {
  return join(workspaceAutomationsDir(workDir, wsId, ownerId), RUNS_SEGMENT);
}

/** Immediate subdirectory names of `dir`; empty when the dir is absent or unreadable. */
function listSubdirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
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
  ensureWorkspaceDir(dir);
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
/** Stamp the directory binding onto a record when its stored wsId/ownerId is missing. */
function backfillBinding(auto: Automation, wsId: string, ownerId: string): void {
  if (typeof auto.workspaceId !== "string" || auto.workspaceId.length === 0) {
    auto.workspaceId = wsId;
  }
  if (typeof auto.ownerId !== "string" || auto.ownerId.length === 0) {
    auto.ownerId = ownerId;
  }
}

/** One owner's automations, with wsId/ownerId recovered from the path binding and backfilled. */
function loadOwnerAutomationsResolved(
  workDir: string,
  wsId: string,
  ownerId: string,
): Automation[] {
  // Recover the binding from the path, not the record.
  const parsed = parseAutomationPath(workspaceAutomationsDir(workDir, wsId, ownerId));
  const resolvedWsId = parsed?.wsId ?? wsId;
  const resolvedOwnerId = parsed?.ownerId ?? ownerId;
  const owned: Automation[] = [];
  for (const auto of loadOwnerAutomations(workDir, resolvedWsId, resolvedOwnerId).values()) {
    backfillBinding(auto, resolvedWsId, resolvedOwnerId);
    owned.push(auto);
  }
  return owned;
}

export function loadAllAutomations(workDir: string): Automation[] {
  const wsRoot = join(workDir, WORKSPACES_SEGMENT);
  const out: Automation[] = [];
  for (const wsId of listSubdirNames(wsRoot)) {
    const autoRoot = join(wsRoot, wsId, AUTOMATIONS_SEGMENT);
    for (const ownerId of listSubdirNames(autoRoot)) {
      out.push(...loadOwnerAutomationsResolved(workDir, wsId, ownerId));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runs — runs/<automationId>/index.jsonl (hot) + index-YYYY-MM.jsonl (segments)
// ---------------------------------------------------------------------------

/** The month (`YYYY-MM`, UTC) a run summary line belongs to: its run's start month. */
function segmentMonthOf(line: string, fallbackMs: number): string {
  let ms = Number.NaN;
  try {
    ms = new Date((JSON.parse(line) as AutomationRun).startedAt).getTime();
  } catch {
    // malformed line: kept, in the month it rolled over
  }
  return new Date(Number.isFinite(ms) ? ms : fallbackMs).toISOString().slice(0, 7);
}

/**
 * Append a run summary to the automation's hot index. Creates directories and
 * the file if missing. When the hot index passes MAX_RUN_LINES, the oldest
 * lines roll into the month segments of the runs they record; nothing is
 * deleted, and result sidecars stay where they are.
 *
 * Segments are appended before the hot index is rewritten, so a crash between
 * the two can repeat a line in a segment but never lose one; the paged reader
 * drops repeated ids.
 */
export function appendRun(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  run: AutomationRun,
): void {
  const dir = automationRunsDir(workDir, wsId, ownerId, automationId);
  ensureWorkspaceDir(dir);
  const filePath = automationRunIndexPath(workDir, wsId, ownerId, automationId);

  appendFileSync(filePath, `${JSON.stringify(run)}\n`);

  const content = readFileSync(filePath, "utf-8").trimEnd();
  const lines = content.split("\n");
  if (lines.length <= MAX_RUN_LINES) return;

  const rolled = lines.slice(0, lines.length - MAX_RUN_LINES);
  const kept = lines.slice(lines.length - MAX_RUN_LINES);
  const byMonth = new Map<string, string[]>();
  const now = Date.now();
  for (const line of rolled) {
    if (!line) continue;
    const month = segmentMonthOf(line, now);
    const group = byMonth.get(month);
    if (group) group.push(line);
    else byMonth.set(month, [line]);
  }
  for (const [month, group] of byMonth) {
    appendFileSync(
      automationRunSegmentPath(workDir, wsId, ownerId, automationId, month),
      `${group.join("\n")}\n`,
    );
  }
  atomicWrite(filePath, `${kept.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Read Runs
// ---------------------------------------------------------------------------

export interface ReadRunsOptions {
  limit?: number;
  since?: string; // ISO timestamp
  status?: AutomationRun["status"];
  /**
   * ISO timestamp: only runs started before it, read a page at a time back
   * through the month segments ({@link readRunsPage}). Absent: the hot index
   * alone.
   */
  before?: string;
}

/** Parse a JSONL run index; a missing or empty file reads as no runs. Malformed lines are skipped. */
function readIndexFile(filePath: string): AutomationRun[] {
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
  return runs;
}

/**
 * Read run history for a single automation from its hot index: the newest
 * MAX_RUN_LINES runs, newest first, with optional filters. With `before`, a
 * paged read that also walks the month segments ({@link readRunsPage}).
 */
export function readRuns(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  opts?: ReadRunsOptions,
): AutomationRun[] {
  if (opts?.before !== undefined) {
    return readRunsPage(workDir, wsId, ownerId, automationId, opts).runs;
  }
  const runs = readIndexFile(automationRunIndexPath(workDir, wsId, ownerId, automationId));
  runs.reverse(); // newest first
  return applyFilters(runs, opts);
}

/** Months (`YYYY-MM`) that have a run-index segment for the automation, newest first. */
export function listRunSegmentMonths(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
): string[] {
  let names: string[];
  try {
    names = readdirSync(automationRunsDir(workDir, wsId, ownerId, automationId));
  } catch {
    return [];
  }
  const months: string[] = [];
  for (const name of names) {
    const month = parseRunSegmentFileName(name);
    if (month) months.push(month);
  }
  return months.sort().reverse();
}

/** Epoch ms of the first instant after `month` (`YYYY-MM`, UTC). */
function monthEndMs(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return Date.UTC(y!, m!, 1);
}

const startedMs = (r: AutomationRun) => new Date(r.startedAt).getTime();

/**
 * Read segments (`months`, newest first) into `picked` through `read` until no
 * unread one can hold a run the page needs. Returns how many segments that
 * might still hold matching runs were left unread.
 */
function walkSegments(
  months: string[],
  bounds: { beforeMs: number; sinceMs: number; limit: number },
  picked: AutomationRun[],
  read: (month: string) => void,
): number {
  let unread = months.length;
  for (const month of months) {
    const end = monthEndMs(month);
    // Wholly before `since`: so is every older segment.
    if (end <= bounds.sinceMs) return 0;
    const start = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1);
    if (start >= bounds.beforeMs) {
      unread--;
      continue;
    }
    // Full with runs newer than anything this segment (or an older one) holds.
    if (picked.filter((r) => startedMs(r) >= end).length >= bounds.limit) break;
    read(month);
    unread--;
  }
  return unread;
}

export interface RunsPage {
  /** Newest first. */
  runs: AutomationRun[];
  /**
   * Pass as `before` for the next older page; absent when nothing older
   * remains. A page that would end inside a group of runs sharing one start
   * time takes the whole group, so the cursor never splits it.
   */
  nextBefore?: string;
}

/**
 * One page of an automation's run history, newest first.
 *
 * Without `opts.before` it is the first page, read from the hot index alone,
 * so it costs what {@link readRuns} costs; `nextBefore` is set when the hot
 * index holds more matches or any segment exists (a directory listing, not a
 * read). With `before`, it is runs started before it, across the hot index and
 * the month segments.
 *
 * Reads the hot index, then segments newest month first, and stops as soon as
 * the page is full of runs newer than every unread segment can hold: a segment
 * for month M holds only runs started in M, so a page whose last run started
 * after M ends needs nothing from it. A segment whose month starts after
 * `before` is skipped unread.
 */
export function readRunsPage(
  workDir: string,
  wsId: string,
  ownerId: string,
  automationId: string,
  opts: ReadRunsOptions = {},
): RunsPage {
  const limit = Math.max(1, opts.limit ?? 20);
  const beforeMs = opts.before !== undefined ? new Date(opts.before).getTime() : Infinity;
  if (Number.isNaN(beforeMs)) throw new Error(`Invalid before timestamp: "${opts.before}"`);
  const sinceMs = opts.since !== undefined ? new Date(opts.since).getTime() : -Infinity;
  const seen = new Set<string>();
  const picked: AutomationRun[] = [];
  const take = (runs: AutomationRun[]) => {
    for (const r of runs) {
      const t = startedMs(r);
      if (!(t < beforeMs) || t < sinceMs) continue;
      if (opts.status && r.status !== opts.status) continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      picked.push(r);
    }
  };

  take(readIndexFile(automationRunIndexPath(workDir, wsId, ownerId, automationId)));
  const months = listRunSegmentMonths(workDir, wsId, ownerId, automationId);
  // The first page reads no segment; a later one walks them newest first.
  const unread =
    opts.before === undefined
      ? months.length
      : walkSegments(months, { beforeMs, sinceMs, limit }, picked, (month) =>
          take(
            readIndexFile(automationRunSegmentPath(workDir, wsId, ownerId, automationId, month)),
          ),
        );

  picked.sort((a, b) => startedMs(b) - startedMs(a));
  let cut = Math.min(limit, picked.length);
  // Never split a group of runs that share a start time across pages.
  while (
    cut > 0 &&
    cut < picked.length &&
    startedMs(picked[cut]!) === startedMs(picked[cut - 1]!)
  ) {
    cut++;
  }
  const runs = picked.slice(0, cut);
  const more = cut < picked.length || unread > 0;
  const last = runs[runs.length - 1];
  return more && last ? { runs, nextBefore: last.startedAt } : { runs };
}

/**
 * Read runs across every automation owned by `ownerId` in `wsId`. Newest first,
 * with optional filters. Reads each automation's hot index; with `before`,
 * pages back through each one's segments.
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
    if (opts?.before !== undefined) {
      allRuns.push(...readRunsPage(workDir, wsId, ownerId, id, opts).runs);
      continue;
    }
    allRuns.push(...readIndexFile(automationRunIndexPath(workDir, wsId, ownerId, id)));
  }

  allRuns.sort((a, b) => startedMs(b) - startedMs(a));
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
  ensureWorkspaceDir(dir);
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
