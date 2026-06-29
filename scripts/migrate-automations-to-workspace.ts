#!/usr/bin/env bun

/**
 * One-time migration: identity-owned automation store → the workspace-owned,
 * per-automation layout.
 *
 * Automations used to live under the user's identity partition as a single
 * collection file plus a per-automation run log:
 *
 *   users/<ownerId>/automations/automations.json          { version, updatedAtMs, automations[] }
 *   users/<ownerId>/automations/runs/<automationId>.jsonl  append-only AutomationRun summaries
 *
 * The workspace now owns the directory and each automation is its own file, with
 * the owner as a privacy sub-partition (see `research/SPEC-permission-boundaries.md`):
 *
 *   workspaces/<wsId>/automations/<ownerId>/<automationId>.json          a bare Automation
 *   workspaces/<wsId>/automations/<ownerId>/runs/<automationId>/index.jsonl  AutomationRun summaries
 *
 * This walks each `users/<ownerId>/automations/automations.json` collection and
 * writes every automation to its workspace-owned home. The destination workspace
 * is the automation's `workspaceId` when set, else the owner's personal
 * workspace; the owner is the user. Each run-log line is copied through with the
 * `conversationId` field stripped (an automation run is no longer a conversation,
 * so the field no longer exists on the type).
 *
 * Usage:
 *   bun run migrate:automations-to-workspace                  # dry-run (default)
 *   bun run migrate:automations-to-workspace --write          # apply the moves
 *   bun run migrate:automations-to-workspace --work-dir /abs  # target a work-dir
 *
 * Safe by default: a dry-run prints the planned moves, writes nothing, and
 * exits 0. `--write` (or `--apply`) performs the moves under the work-dir's
 * `.migration-lock`. Idempotent: a destination `<automationId>.json` that
 * already exists is treated as already-migrated and skipped, and a run log whose
 * `index.jsonl` already exists is left untouched (never re-appended), so a re-run
 * after a crash or partial run reports zero moves and never duplicates run lines.
 * The source `users/<ownerId>/automations/` tree is left in place.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  automationFilePath,
  automationRunIndexPath,
  validateAutomationId,
} from "../src/bundles/automations/src/paths.ts";
import type { Automation, AutomationsFile } from "../src/bundles/automations/src/types.ts";
import { personalWorkspaceIdFor } from "../src/workspace/workspace-store.ts";
import { acquireMigrationLock } from "./lib/migration-lock.ts";

const MIGRATION_NAME = "automations-to-workspace";

/**
 * Is `id` a valid automation id? Defers to the sanctioned validator in
 * `src/bundles/automations/src/paths.ts` (kebab-case) so this migration shares
 * the one definition instead of re-deriving the rule, and an invalid id is
 * skipped/counted rather than throwing mid-run.
 */
function isValidAutomationId(id: string): boolean {
  try {
    validateAutomationId(id);
    return true;
  } catch {
    return false;
  }
}

/** A single automation's planned (dry-run) or performed (write) disposition. */
interface MovePlan {
  ownerId: string;
  wsId: string;
  automationId: string;
  /** Absolute path of the target bare-Automation file. */
  to: string;
  /** `move` — write a fresh target; `existing` — target already present, skip. */
  action: "move" | "existing";
  /** Run-log disposition: `move` — wrote index.jsonl; `existing` — index already
   *  present, left untouched; `none` — the automation has no source run log. */
  runs: "move" | "existing" | "none";
}

export interface AutomationMigrationSummary {
  /** Automations written to a fresh destination (or that would be, in dry-run). */
  moved: number;
  /** Automations whose destination already existed — treated as already-migrated. */
  skippedExisting: number;
  /** Automations whose id isn't valid kebab-case. */
  skippedInvalidId: number;
  /** Run logs written to a fresh `index.jsonl` (or that would be, in dry-run). */
  runsMoved: number;
  /** Run logs skipped because the destination `index.jsonl` already existed. */
  runsSkippedExisting: number;
  /** The per-automation dispositions, for printing / assertions. */
  plans: MovePlan[];
}

function emptySummary(): AutomationMigrationSummary {
  return {
    moved: 0,
    skippedExisting: 0,
    skippedInvalidId: 0,
    runsMoved: 0,
    runsSkippedExisting: 0,
    plans: [],
  };
}

/**
 * The destination workspace for an automation: its explicit `workspaceId` when a
 * non-empty string, else the owner's personal workspace. Mirrors
 * `personalWorkspaceIdFor` — the personal workspace id is the literal
 * `ws_user_<ownerId>` (ownerId is the user id).
 */
function resolveWsId(automation: Automation, ownerId: string): string {
  const ws = automation.workspaceId;
  if (typeof ws === "string" && ws.length > 0) return ws;
  return personalWorkspaceIdFor(ownerId);
}

/** The owner's identity-scoped automations dir under `{workDir}/users/<ownerId>/automations/`. */
function sourceAutomationsDir(workDir: string, ownerId: string): string {
  return join(workDir, "users", ownerId, "automations");
}

/**
 * Write `content` to `destFile` without a window where a partial file is visible:
 * write to a temp sibling in the destination dir, then rename it over the
 * destination. The source is never touched (the identity tree is left in place).
 */
function atomicWrite(destFile: string, content: string): void {
  const destDir = dirname(destFile);
  mkdirSync(destDir, { recursive: true });
  const tmpFile = join(destDir, `.${basename(destFile)}.${process.pid}.tmp`);
  writeFileSync(tmpFile, content, "utf-8");
  renameSync(tmpFile, destFile);
}

/** The owner directories under `{workDir}/users/` that hold an `automations/automations.json`. */
function ownerIdsWithAutomations(workDir: string): string[] {
  const usersDir = join(workDir, "users");
  let entries: string[];
  try {
    entries = readdirSync(usersDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries.filter((ownerId) =>
    existsSync(join(sourceAutomationsDir(workDir, ownerId), "automations.json")),
  );
}

/** Load the `automations.json` collection for an owner; `[]` if unreadable. */
function loadCollection(workDir: string, ownerId: string): Automation[] {
  const filePath = join(sourceAutomationsDir(workDir, ownerId), "automations.json");
  try {
    const data = JSON.parse(readFileSync(filePath, "utf-8")) as AutomationsFile;
    return Array.isArray(data.automations) ? data.automations : [];
  } catch {
    return [];
  }
}

/**
 * Read the source run log for an automation and return its lines with the
 * `conversationId` field stripped from each record, ready to write as
 * `index.jsonl`. Returns `null` when the source log doesn't exist. Unparseable
 * lines are dropped (matching the store's tolerant reader).
 */
function readStrippedRunLines(
  workDir: string,
  ownerId: string,
  automationId: string,
): string[] | null {
  const srcRunFile = join(sourceAutomationsDir(workDir, ownerId), "runs", `${automationId}.jsonl`);
  if (!existsSync(srcRunFile)) return null;
  const content = readFileSync(srcRunFile, "utf-8");
  const out: string[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as Record<string, unknown>;
      delete rec.conversationId;
      out.push(JSON.stringify(rec));
    } catch {
      // A malformed run line can't carry forward; drop it.
    }
  }
  return out;
}

/**
 * Plan (and, when `write`, perform) the relocation of every identity-owned
 * automation into its workspace-owned per-automation home. Pure read in dry-run;
 * acquires the work-dir migration lock for the write path. Returned summary is
 * exported for the integration test.
 */
export function migrateAutomationsToWorkspace(
  workDir: string,
  opts: { write: boolean },
): AutomationMigrationSummary {
  const summary = emptySummary();
  const ownerIds = ownerIdsWithAutomations(workDir);
  if (ownerIds.length === 0) return summary;

  const lock = opts.write ? acquireMigrationLock(workDir, MIGRATION_NAME) : null;
  try {
    for (const ownerId of ownerIds) {
      for (const automation of loadCollection(workDir, ownerId)) {
        const automationId = automation.id;

        // Validate the id before it ever lands in a path segment.
        if (typeof automationId !== "string" || !isValidAutomationId(automationId)) {
          summary.skippedInvalidId++;
          continue;
        }

        const wsId = resolveWsId(automation, ownerId);
        const destFile = automationFilePath(workDir, wsId, ownerId, automationId);

        // The automation definition: a bare Automation object, written verbatim.
        let action: MovePlan["action"];
        if (existsSync(destFile)) {
          action = "existing";
          summary.skippedExisting++;
        } else {
          action = "move";
          if (opts.write) atomicWrite(destFile, JSON.stringify(automation, null, 2));
          summary.moved++;
        }

        // The run log: a separate write, gated on its own destination so a crash
        // between the two is recoverable. Strip `conversationId` from each record.
        let runs: MovePlan["runs"] = "none";
        const strippedLines = readStrippedRunLines(workDir, ownerId, automationId);
        if (strippedLines !== null) {
          const runsIndex = automationRunIndexPath(workDir, wsId, ownerId, automationId);
          if (existsSync(runsIndex)) {
            runs = "existing";
            summary.runsSkippedExisting++;
          } else {
            runs = "move";
            if (opts.write) atomicWrite(runsIndex, `${strippedLines.join("\n")}\n`);
            summary.runsMoved++;
          }
        }

        summary.plans.push({ ownerId, wsId, automationId, to: destFile, action, runs });
      }
    }
  } finally {
    lock?.release();
  }

  return summary;
}

function resolveWorkDir(args: string[]): string {
  const eq = args.find((a) => a.startsWith("--work-dir="));
  if (eq) return eq.slice("--work-dir=".length);
  const flagIdx = args.indexOf("--work-dir");
  if (flagIdx !== -1 && args[flagIdx + 1]) return args[flagIdx + 1] as string;
  return process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
}

function main(): void {
  const args = process.argv.slice(2);
  const write = args.includes("--write") || args.includes("--apply");
  const workDir = resolveWorkDir(args);

  try {
    const summary = migrateAutomationsToWorkspace(workDir, { write });

    for (const plan of summary.plans) {
      const label = `${plan.wsId} · ${plan.ownerId}`;
      if (plan.action === "move") {
        console.log(`  [move] ${plan.automationId} → ${label}`);
      } else {
        console.log(`  [skip] ${plan.automationId} already at ${label} — left in place`);
      }
      if (plan.runs === "move") {
        console.log(
          `  [move] ${plan.automationId} runs → ${label}/runs/${plan.automationId}/index.jsonl`,
        );
      } else if (plan.runs === "existing") {
        console.log(`  [skip] ${plan.automationId} runs already migrated — not re-appended`);
      }
    }

    if (summary.skippedInvalidId > 0) {
      console.warn(
        `  [skip] ${summary.skippedInvalidId} automation(s) skipped — id is not valid kebab-case.`,
      );
    }

    console.log(
      `\n${summary.moved} ${write ? "moved" : "to move"} · ` +
        `${summary.skippedExisting} already migrated · ` +
        `${summary.runsMoved} run log(s) ${write ? "moved" : "to move"} · ` +
        `${summary.runsSkippedExisting} run log(s) already migrated · ` +
        `${summary.skippedInvalidId} invalid id`,
    );
    if (!write && (summary.moved > 0 || summary.runsMoved > 0)) {
      console.log("\nDry run — re-run with --write to apply.");
    }
  } catch (err) {
    console.error(`[FATAL] ${MIGRATION_NAME}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// Gate the CLI side effect on direct invocation so tests can import
// `migrateAutomationsToWorkspace` without running the argv/console path.
if (import.meta.main) {
  main();
}
