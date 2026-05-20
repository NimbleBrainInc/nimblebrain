#!/usr/bin/env bun
/**
 * Stage 1 migration: move every conversation from
 * `{workDir}/workspaces/{wsId}/conversations/{convId}.jsonl` to
 * `{workDir}/conversations/{convId}.jsonl`.
 *
 * Also purges the removed event types (`metadata.visibility`,
 * `metadata.participants`) and rewrites the metadata line to drop the
 * same fields — Stage 1's schema purge (see Task 008).
 *
 * One-phase per conversation. Atomic via temp+rename at the destination;
 * the source delete only fires after the destination write succeeds, so
 * a crash leaves the conversation in exactly one of source / destination
 * — never both, and never neither.
 *
 * Crash-recovery: a previous run that crashed between destination-write
 * and source-delete leaves source+destination both present. The next
 * run detects this and re-deletes the stale source — the destination is
 * canonical post-write, so we trust it.
 *
 * Cross-workspace `convId` collisions (same id in two workspaces) are
 * a `[FATAL]` exit: convIds are 16-hex random and a collision is
 * either corruption or a hand-edit. Operators decide.
 *
 * Designed to run during a maintenance window with the platform stopped.
 * Run AFTER `migrate-personal-workspaces.ts` so any conversation
 * `workspaceId` references are already on the post-rename ids.
 *
 * Usage:
 *     bun run scripts/migrate-conversations-to-top-level.ts [--work-dir <path>] [--dry-run]
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const REMOVED_EVENT_TYPES = new Set(["metadata.visibility", "metadata.participants"]);
const CONV_FILE_RE = /^conv_[a-f0-9]{16}\.jsonl$/;

interface Args {
  workDir: string;
  dryRun: boolean;
}

interface Stats {
  found: number;
  moved: number;
  skippedNoOwner: number;
  recovered: number;
  errors: { ctx: string; message: string }[];
}

interface Candidate {
  wsId: string;
  convId: string;
  srcPath: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let workDir = process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--work-dir") {
      workDir = argv[++i] ?? "";
    } else if (arg?.startsWith("--work-dir=")) {
      workDir = arg.slice("--work-dir=".length);
    } else {
      console.error(`[migrate] unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  if (!workDir) {
    console.error("[migrate] --work-dir is required (or set NB_WORK_DIR)");
    process.exit(2);
  }
  return { workDir, dryRun };
}

function printHelp(): void {
  console.log(`
migrate-conversations-to-top-level — Stage 1 of the delegation-model refactor

Moves every conversation from workspaces/{wsId}/conversations/{convId}.jsonl
to conversations/{convId}.jsonl, purges removed event types
(metadata.visibility, metadata.participants), and rewrites the metadata
line to drop the same fields.

Usage:
  bun run scripts/migrate-conversations-to-top-level.ts [options]

Options:
  --work-dir <path>   Override the work directory.
                      Defaults to $NB_WORK_DIR or ~/.nimblebrain.
  --dry-run           Report the planned moves without writing.
  -h, --help          This message.

Run during a maintenance window with the platform stopped. Idempotent —
a second run reports zero moves. Cross-workspace convId collisions exit
non-zero with [FATAL]; operators decide.
`);
}

/**
 * Scan every workspace for conversation files. Returns the move
 * candidates plus a multi-map from convId to its source locations.
 * Empty `workspaces/` or per-workspace `conversations/` dirs are fine —
 * `find: 0` and the script no-ops.
 */
async function scanCandidates(
  workspacesDir: string,
): Promise<{ candidates: Candidate[]; byConvId: Map<string, Candidate[]> }> {
  const candidates: Candidate[] = [];
  const byConvId = new Map<string, Candidate[]>();

  if (!existsSync(workspacesDir)) return { candidates, byConvId };

  const wsEntries = await readdir(workspacesDir, { withFileTypes: true });
  for (const wsEntry of wsEntries) {
    if (!wsEntry.isDirectory()) continue;
    const wsId = wsEntry.name;
    const convDir = join(workspacesDir, wsId, "conversations");
    if (!existsSync(convDir)) continue;

    const files = await readdir(convDir);
    for (const fname of files) {
      // Only conversation files. Skip anything else operators may have
      // dropped here (tmp, .bak, etc.) — don't touch what we don't own.
      if (!CONV_FILE_RE.test(fname)) continue;

      const convId = basename(fname, ".jsonl");
      const cand: Candidate = { wsId, convId, srcPath: join(convDir, fname) };
      candidates.push(cand);

      const existing = byConvId.get(convId);
      if (existing) existing.push(cand);
      else byConvId.set(convId, [cand]);
    }
  }

  return { candidates, byConvId };
}

/**
 * Detect same-convId-in-two-workspaces collisions. Returns the offending
 * groups so the caller can log all of them before exiting.
 *
 * convIds are 16-hex random — a collision is corruption or hand-edit,
 * never a normal state. We refuse to choose a winner.
 */
function detectCollisions(byConvId: Map<string, Candidate[]>): Candidate[][] {
  const collisions: Candidate[][] = [];
  for (const [, locs] of byConvId) {
    if (locs.length > 1) collisions.push(locs);
  }
  return collisions;
}

/**
 * Rewrite a conversation file from source to destination, dropping the
 * removed event types and stripping the removed metadata fields. Returns
 * `null` if the file is missing its `ownerId` and must be skipped.
 */
function rewriteConversation(raw: string): { output: string } | { skip: "no-owner" } {
  // The file format is JSONL: line 1 is the conversation metadata,
  // every subsequent non-empty line is a ConversationEvent. The
  // trailing newline is preserved so the on-disk shape stays uniform.
  const lines = raw.split("\n");
  const metaLine = lines[0] ?? "";

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metaLine) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `metadata line is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Stage 1 invariant: every conversation has an owner. Pre-Stage-1
  // files without one are operator-must-decide territory — skip rather
  // than synthesize an owner from thin air.
  if (typeof meta.ownerId !== "string" || meta.ownerId.length === 0) {
    return { skip: "no-owner" };
  }

  // Strip removed schema fields. Parse-then-serialize, never a
  // substring patch on raw JSON.
  delete meta.visibility;
  delete meta.participants;

  // Filter event lines. Non-removed lines pass through byte-identical
  // — we never re-parse content for users / tool calls / llm responses,
  // because re-serialization could subtly reorder keys and break
  // diff-based debugging.
  const eventLines: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      // Unparseable line — preserve as-is so an operator can recover.
      // Don't drop because we can't classify it.
      eventLines.push(line);
      continue;
    }
    const type =
      typeof evt === "object" && evt !== null
        ? ((evt as { type?: unknown }).type as string | undefined)
        : undefined;
    if (typeof type === "string" && REMOVED_EVENT_TYPES.has(type)) continue;
    eventLines.push(line);
  }

  const output = `${JSON.stringify(meta)}\n${eventLines.map((l) => `${l}\n`).join("")}`;
  return { output };
}

/**
 * Move one conversation from source to destination atomically.
 * Returns one of: "moved", "recovered" (destination already there,
 * source deleted), "skip-no-owner". Throws on hard errors.
 */
async function moveConversation(
  cand: Candidate,
  destPath: string,
  dryRun: boolean,
): Promise<"moved" | "recovered" | "skip-no-owner"> {
  // Recovery path: destination already exists from a prior interrupted
  // run. The destination write was atomic (temp+rename), so the file
  // there is structurally complete — trust it. Just clear the source.
  //
  // Note that we do NOT compare source/destination contents. The
  // documented operational model has the platform stopped during
  // migration, so source + destination existing simultaneously is
  // unambiguously a crash-between-rename-and-unlink. Operators who
  // somehow get here with different content need the log line.
  if (existsSync(destPath)) {
    if (dryRun) {
      console.error(
        `[migrate]   [dry-run] would delete stale source ${cand.wsId}/${cand.convId} (destination already migrated)`,
      );
    } else {
      console.error(
        `[migrate]   recovery: deleting stale source workspaces/${cand.wsId}/conversations/${cand.convId}.jsonl (destination already migrated; contents not compared)`,
      );
      await unlink(cand.srcPath);
    }
    return "recovered";
  }

  const raw = await readFile(cand.srcPath, "utf-8");
  const result = rewriteConversation(raw);
  if ("skip" in result) {
    if (result.skip === "no-owner") {
      console.warn(
        `[migrate]   SKIP ${cand.wsId}/${cand.convId}: metadata missing ownerId (operator must back-fill)`,
      );
      return "skip-no-owner";
    }
  }
  if (!("output" in result)) {
    // Exhaustiveness — shouldn't happen, but TS narrows here.
    throw new Error("rewriteConversation returned no output and no skip");
  }

  if (dryRun) {
    console.error(`[migrate]   [dry-run] would move ${cand.wsId}/${cand.convId} → top-level`);
    return "moved";
  }

  // Atomic destination write: temp + rename. The rename is the
  // commit point — once it succeeds, the destination is canonical.
  const tmp = `${destPath}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, result.output, { mode: 0o600 });
  await rename(tmp, destPath);

  // Source delete completes the move. If the process dies after the
  // rename but before the unlink, the next run hits the recovery path
  // above and finishes the cleanup.
  await unlink(cand.srcPath);
  return "moved";
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.error(
    `[migrate] workDir=${args.workDir}${args.dryRun ? " (dry-run)" : ""}`,
  );

  const workspacesDir = join(args.workDir, "workspaces");
  const destDir = join(args.workDir, "conversations");

  const { candidates, byConvId } = await scanCandidates(workspacesDir);
  console.error(`[migrate] found ${candidates.length} conversation file(s) under workspaces/`);

  // Phase 1 — fatal collision detection. Better to refuse the whole
  // batch than half-migrate and leave operators reconciling.
  const collisions = detectCollisions(byConvId);
  if (collisions.length > 0) {
    console.error(
      `[migrate] [FATAL] same convId appears in multiple workspaces (${collisions.length} group(s)):`,
    );
    for (const group of collisions) {
      console.error(`[migrate]   convId=${group[0]!.convId}`);
      for (const loc of group) {
        console.error(`[migrate]     ${loc.srcPath}`);
      }
    }
    console.error(
      `[migrate] [FATAL] operator must reconcile before re-running. Refusing to proceed.`,
    );
    process.exit(2);
  }

  if (candidates.length === 0) {
    console.error(`[migrate] nothing to do.`);
    return;
  }

  if (!args.dryRun) {
    await mkdir(destDir, { recursive: true });
  }

  const stats: Stats = {
    found: candidates.length,
    moved: 0,
    skippedNoOwner: 0,
    recovered: 0,
    errors: [],
  };

  for (const cand of candidates) {
    const destPath = join(destDir, `${cand.convId}.jsonl`);
    try {
      const outcome = await moveConversation(cand, destPath, args.dryRun);
      if (outcome === "moved") stats.moved++;
      else if (outcome === "recovered") stats.recovered++;
      else if (outcome === "skip-no-owner") stats.skippedNoOwner++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[migrate] ERROR ${cand.wsId}/${cand.convId}: ${message}`);
      stats.errors.push({ ctx: `${cand.wsId}/${cand.convId}`, message });
    }
  }

  console.error("");
  console.error(`[migrate] summary${args.dryRun ? " (dry-run)" : ""}:`);
  console.error(`[migrate]   conversations found:     ${stats.found}`);
  console.error(`[migrate]   moved:                   ${stats.moved}`);
  console.error(`[migrate]   recovered (post-crash):  ${stats.recovered}`);
  console.error(`[migrate]   skipped (no ownerId):    ${stats.skippedNoOwner}`);
  console.error(`[migrate]   collisions:              0`);
  console.error(`[migrate]   errors:                  ${stats.errors.length}`);
  if (stats.errors.length > 0) {
    for (const e of stats.errors) console.error(`[migrate]     [error] ${e.ctx}: ${e.message}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
