#!/usr/bin/env bun
/**
 * Replay history into the usage ledger, so the report covers spend that
 * predates it.
 *
 * Two sources, with different fidelity:
 *
 *   conversation JSONL  — exact. `llm.response` and `aux.usage` carry `ts`,
 *                         `model` and the full usage struct; owner and
 *                         workspace come from the path.
 *   automation runs     — approximate. The run record has `{inputTokens,
 *                         outputTokens, iterations}` and no model, so the line
 *                         is written per RUN rather than per call, with
 *                         `model: "unknown"`. The reader reports those as
 *                         unpriced rather than as free.
 *
 * ## The cutover boundary
 *
 * The reader unions the backfill shard with the live ones. Once the live writer
 * is running, a chat call is recorded to a live shard *and* written to the
 * conversation log — so replaying that conversation would count it twice, and
 * an over-report is worse than the undercount it replaces because it cannot be
 * reconciled either and looks authoritative.
 *
 * So every source event at or after the cutoff is skipped. The default cutoff
 * is per-month: the earliest `ts` in that month's live shards, which is the
 * live writer's own start. A month with no live shard replays entirely; the
 * cutover month replays exactly the part the writer missed.
 *
 * That default is re-derived on each run, so if a month's earliest live shard
 * is ever removed — retention, or a hand-pruned tree — the computed cutoff
 * moves forward and a re-run would replay already-recorded calls. Pass
 * `--before` explicitly in that case.
 *
 * ## Idempotency
 *
 * The backfill shard is rewritten wholesale, never appended, so re-running is
 * safe with respect to itself. That says nothing about the read path, which
 * unions shards — the cutoff is what covers that, and the two are not
 * substitutes.
 *
 * Usage:
 *   bun run migrate:usage-ledger -- --work-dir <dir> [--before <ISO-8601>] [--skip-automations] [--dry-run]
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { parseConversationPath } from "../src/conversation/paths.ts";
import { resolveRates } from "../src/usage/cost.ts";
import {
  isBackfillShard,
  usageBackfillPath,
  usageMonthDir,
  usageMonthOf,
  usageRoot,
} from "../src/usage/paths.ts";
import type { TokenUsage, UsageLedgerEntry } from "../src/usage/types.ts";

/**
 * The layout moved out from under `isRunIndex`.
 *
 * Thrown rather than exited so the check is reachable from a test.
 * `collectEntries` is exported, and a `process.exit` inside it kills the test
 * runner mid-file — hiding this direction, and silently stopping later test
 * files from executing at all. The library function reports; `main` exits.
 */
export class LayoutMovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutMovedError";
  }
}

interface Args {
  workDir: string;
  before?: string;
  skipAutomations: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const workDir = get("--work-dir");
  if (!workDir) {
    console.error("usage: --work-dir <dir> [--before <ISO-8601>] [--skip-automations] [--dry-run]");
    process.exit(1);
  }
  return {
    workDir,
    ...(get("--before") ? { before: get("--before") as string } : {}),
    skipAutomations: argv.includes("--skip-automations"),
    dryRun: argv.includes("--dry-run"),
  };
}

/** Every file under `dir` matching `predicate`, recursively. */
export function walk(
  dir: string,
  predicate: (path: string) => boolean,
  out: string[] = [],
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(path, predicate, out);
    else if (predicate(path)) out.push(path);
  }
  return out;
}

/** The earliest `ts` in one shard, or undefined if it has no readable line. */
function earliestTs(path: string): string | undefined {
  let earliest: string | undefined;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line) continue;
    try {
      const ts = (JSON.parse(line) as { ts?: string }).ts;
      if (ts && (!earliest || ts < earliest)) earliest = ts;
    } catch {
      // A torn tail line tells us nothing about the writer's start.
    }
  }
  return earliest;
}

/**
 * The live writer's earliest `ts` per month — the per-month default cutoff.
 *
 * A month absent from the map has no live shard and replays in full.
 */
function liveStartsByMonth(workDir: string): Map<string, string> {
  const starts = new Map<string, string>();
  let months: string[];
  try {
    months = readdirSync(usageRoot(workDir)).filter((m) => /^\d{4}-\d{2}$/.test(m));
  } catch {
    return starts;
  }
  for (const month of months) {
    const dir = usageMonthDir(workDir, month);
    for (const shard of readdirSync(dir)) {
      if (!shard.endsWith(".jsonl") || isBackfillShard(shard)) continue;
      const earliest = earliestTs(join(dir, shard));
      const current = starts.get(month);
      if (earliest && (!current || earliest < current)) starts.set(month, earliest);
    }
  }
  return starts;
}

/** One conversation event as a ledger line, or null when it records no spend. */
function conversationEventToEntry(
  line: string,
  attribution: Pick<UsageLedgerEntry, "userId" | "workspaceId" | "sessionId">,
): UsageLedgerEntry | null {
  let event: { ts?: string; type?: string; model?: string; usage?: TokenUsage; source?: string };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (event.type !== "llm.response" && event.type !== "aux.usage") return null;
  if (!event.ts || !event.usage || !event.model) return null;
  const rates = resolveRates(event.model);
  return {
    ts: event.ts,
    source: event.source ?? "main",
    // Everything in a conversation log is chat spend by construction: a task run
    // writes no conversation, which is the defect being backfilled around.
    origin: "chat",
    delegated: false,
    model: event.model,
    usage: event.usage,
    llmMs: 0,
    ...attribution,
    ...(rates ? { rates } : {}),
  };
}

/** Replay one conversation log. Exact: every field the ledger needs is present. */
function fromConversation(path: string): UsageLedgerEntry[] {
  const parsed = parseConversationPath(path);
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  // Line 1 is conversation metadata; its id is the session these calls belong to.
  let sessionId: string | undefined;
  try {
    sessionId = (JSON.parse(lines[0] ?? "{}") as { id?: string }).id;
  } catch {
    // No metadata line: the calls still count, they just lose their session.
  }

  const attribution = {
    ...(parsed?.ownerId ? { userId: parsed.ownerId } : {}),
    ...(parsed?.wsId ? { workspaceId: parsed.wsId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  const entries: UsageLedgerEntry[] = [];
  for (const line of lines.slice(1)) {
    const entry = conversationEventToEntry(line, attribution);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Replay one automation's run index.
 *
 * Approximate, and the limit this cannot design away: the record carries
 * `{inputTokens, outputTokens, iterations}` with no model and no per-call
 * split, so it yields one line per RUN with `model: "unknown"`. The reader
 * counts those as unpriced — tokens without a dollar figure — rather than
 * pricing them at zero, which would read as free.
 */
function fromAutomationRuns(path: string): UsageLedgerEntry[] {
  const entries: UsageLedgerEntry[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line) continue;
    let run: {
      id?: string;
      ts?: string;
      startedAt?: string;
      inputTokens?: number;
      outputTokens?: number;
    };
    try {
      run = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = run.ts ?? run.startedAt;
    if (!ts) continue;
    const inputTokens = run.inputTokens ?? 0;
    const outputTokens = run.outputTokens ?? 0;
    if (inputTokens === 0 && outputTokens === 0) continue;
    entries.push({
      ts,
      source: "main",
      origin: "task",
      delegated: false,
      model: "unknown",
      usage: { inputTokens, outputTokens },
      llmMs: 0,
      ...(run.id ? { sessionId: run.id } : {}),
    });
  }
  return entries;
}

/**
 * A run index: `automations/<ownerId>/runs/<automationId>/index.jsonl`.
 *
 * The automation id between `runs/` and the file is the part that matters.
 * Matching `runs/index.jsonl` — no id segment — matches nothing on a real tree,
 * and finding nothing is indistinguishable from having nothing to find: the
 * migration reports success having omitted every automation run, which on a
 * deployment that leans on automations is most of the spend this ledger exists
 * to show.
 */
export function isRunIndex(path: string): boolean {
  if (basename(path) !== "index.jsonl") return false;
  // The grandparent, because the automation id sits between `runs/` and the file.
  return basename(dirname(dirname(path))) === "runs";
}

/** Every replayable line under the given roots. */
export function collectEntries(roots: string[], skipAutomations: boolean): UsageLedgerEntry[] {
  const entries: UsageLedgerEntry[] = [];
  for (const root of roots) {
    const isConversation = (p: string) =>
      p.includes(`${sep}conversations${sep}`) && p.endsWith(".jsonl");
    for (const path of walk(root, isConversation)) entries.push(...fromConversation(path));
    if (skipAutomations) continue;

    // Refuse to look clean — but only on evidence the layout actually moved.
    //
    // The discriminator is an `index.jsonl` under an automations tree that this
    // predicate did NOT match. That is a run history written somewhere else,
    // which is the failure being guarded. A definition with no `runs/` subtree
    // is not evidence of anything: the directory is created lazily on first
    // execution, so an automation created and never run looks exactly like one
    // whose runs moved. A guard keyed on definitions cannot tell them apart and
    // takes down a healthy tree, and the conversation half with it.
    const runIndexes = walk(root, isRunIndex);
    const strayIndexes = walk(
      root,
      (p) => p.includes(`${sep}automations${sep}`) && p.endsWith("index.jsonl") && !isRunIndex(p),
    );
    if (strayIndexes.length > 0) {
      throw new LayoutMovedError(
        `${strayIndexes.length} run index/indexes under ${root} are not at ` +
          `automations/<owner>/runs/<automation>/index.jsonl:\n` +
          strayIndexes
            .slice(0, 3)
            .map((p) => `    ${p}`)
            .join("\n") +
          `\n  The layout has moved. Replaying now would silently omit those runs, ` +
          `which is the spend this ledger exists to show.`,
      );
    }
    for (const path of runIndexes) entries.push(...fromAutomationRuns(path));
  }
  return entries;
}

/**
 * Bucket by month, dropping everything at or after that month's cutoff.
 *
 * The drop is the whole point: those calls are already in a live shard, and the
 * reader unions the shards. See the header.
 */
function partitionByMonth(
  entries: UsageLedgerEntry[],
  before: string | undefined,
  liveStarts: Map<string, string>,
): { byMonth: Map<string, UsageLedgerEntry[]>; skipped: number } {
  const byMonth = new Map<string, UsageLedgerEntry[]>();
  let skipped = 0;
  for (const entry of entries) {
    const month = usageMonthOf(entry.ts);
    const cutoff = before ?? liveStarts.get(month);
    if (cutoff && entry.ts >= cutoff) {
      skipped++;
      continue;
    }
    const bucket = byMonth.get(month) ?? [];
    bucket.push(entry);
    byMonth.set(month, bucket);
  }
  return { byMonth, skipped };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workspacesRoot = join(args.workDir, "workspaces");
  const archivedRoot = join(args.workDir, "archived");

  const entries = collectEntries([workspacesRoot, archivedRoot], args.skipAutomations);
  // What was scanned, not only what will be written. A count of zero for either
  // source is the signal that a predicate stopped matching, and it is invisible
  // in a summary that reports written lines alone.
  const bySource = entries.reduce(
    (acc, e) => {
      if (e.origin === "task") acc.automation++;
      else acc.conversation++;
      return acc;
    },
    { conversation: 0, automation: 0 },
  );
  console.log(
    `  scanned: ${bySource.conversation} conversation call(s), ` +
      `${bySource.automation} automation run(s)`,
  );
  const liveStarts = liveStartsByMonth(args.workDir);
  const { byMonth, skipped } = partitionByMonth(entries, args.before, liveStarts);

  let written = 0;
  for (const [month, monthEntries] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    monthEntries.sort((a, b) => a.ts.localeCompare(b.ts));
    const path = usageBackfillPath(args.workDir, month);
    const body = `${monthEntries.map((e) => JSON.stringify(e)).join("\n")}\n`;
    if (!args.dryRun) {
      mkdirSync(usageMonthDir(args.workDir, month), { recursive: true });
      // Wholesale, never appended — that is what makes a re-run idempotent
      // against itself.
      writeFileSync(path, body);
    }
    written += monthEntries.length;
    const cutoff = args.before ?? liveStarts.get(month) ?? "(none — full replay)";
    console.log(`  ${month}: ${monthEntries.length} lines, cutoff ${cutoff}`);
  }

  console.log(
    `${args.dryRun ? "[dry run] " : ""}${written} line(s) written across ${byMonth.size} month(s); ` +
      `${skipped} skipped at or after the cutoff (already recorded by the live writer).`,
  );
}

// Gate the run on direct invocation, matching the check scripts. Without it,
// importing anything from this file executes the migration's arg parsing and
// exits the importer — which is what made the predicate untestable, and so
// untested.
if (import.meta.main) {
  main().catch((err: unknown) => {
    // A moved layout is an operator-facing condition, not a stack trace.
    console.error(err instanceof LayoutMovedError ? `✗ ${err.message}` : err);
    process.exit(1);
  });
}
