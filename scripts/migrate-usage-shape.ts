#!/usr/bin/env bun
/**
 * One-shot migration for the TokenUsage unification (PR #151).
 *
 * The unification PR moved per-call token counts from flat fields on
 * `llm.response` events (and `StoredMessage.metadata`) into a nested
 * `usage: TokenUsage` struct, and renamed `cacheCreationTokens` →
 * `cacheWriteTokens`. New readers do NOT migrate old data — they read
 * `usage` and skip events that don't have it, contributing zero to
 * derived totals. Pre-deploy conversations therefore display $0 / 0
 * tokens after deploy.
 *
 * This script rewrites old-shape conversations in place so derived
 * totals come back. It's a backstop, not a hard requirement: the
 * runtime tolerates missing `usage` (returns zero); this just restores
 * the historical numbers.
 *
 * What it migrates:
 *
 *   Event-format files (line 1 has `format: "events"` or any line 2+
 *   parses as a typed event):
 *     llm.response:
 *       inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
 *       reasoningTokens (flat) → usage: { inputTokens, outputTokens,
 *       cacheReadTokens, cacheWriteTokens, reasoningTokens }
 *
 *   Legacy message-format files (line 2+ are StoredMessage objects with
 *   a `role` field):
 *     assistant.metadata:
 *       inputTokens, outputTokens, cacheReadTokens (flat) →
 *       usage: { inputTokens, outputTokens, cacheReadTokens }
 *       costUsd → DROPPED (cost is no longer stored; computed at read)
 *
 * What it leaves alone:
 *   - Events/messages already in the new shape (idempotent)
 *   - User messages, tool events, run bookends
 *   - Line 1 conversation metadata (totalInputTokens etc. are dead
 *     fields now but harmless on disk; readers ignore them)
 *   - Malformed JSON lines (preserved as-is, never rewritten)
 *
 * Safety:
 *   - Atomic writes (tmp file + rename); never a half-written file.
 *   - Backups by default (`.jsonl.bak` next to each modified file).
 *     Pass `--no-backup` to skip if you have your own snapshots.
 *   - `--dry-run` reports counts without touching files.
 *   - Idempotent: safe to re-run. The second run rewrites zero lines.
 *
 * Usage:
 *     bun run scripts/migrate-usage-shape.ts [conversationsDir] [flags]
 *
 *     conversationsDir defaults to $NB_WORK_DIR/conversations or
 *     ~/.nimblebrain/conversations.
 *
 *     Flags:
 *       --dry-run     Report what would change; write nothing.
 *       --no-backup   Skip .jsonl.bak creation.
 *       --verbose     Per-file logging.
 *
 * On a platform pod:
 *     bun run scripts/migrate-usage-shape.ts /data/conversations
 *
 * After verifying totals look right in the dashboard, you can delete
 * this script and the .jsonl.bak files.
 */

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Args {
  dir: string;
  dryRun: boolean;
  backup: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));
  const defaultDir = join(
    process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain"),
    "conversations",
  );
  return {
    dir: positional[0] ?? defaultDir,
    dryRun: flags.has("--dry-run"),
    backup: !flags.has("--no-backup"),
    verbose: flags.has("--verbose"),
  };
}

interface FileResult {
  path: string;
  scanned: number;
  rewrittenEvents: number;
  rewrittenMessages: number;
  droppedCostUsd: number;
  skipped: boolean;
  malformedLines: number;
}

interface LineMigration {
  text: string;
  rewroteEvent: boolean;
  rewroteMessage: boolean;
  droppedCostUsd: boolean;
  malformed: boolean;
}

const NOOP = (line: string): LineMigration => ({
  text: line,
  rewroteEvent: false,
  rewroteMessage: false,
  droppedCostUsd: false,
  malformed: false,
});

/**
 * Migrate a single line. Returns the (possibly rewritten) line text plus
 * one boolean per kind of change applied. Lines that fail to parse are
 * passed through unchanged with `malformed: true`.
 *
 * Exported for unit testing — see test/unit/scripts/migrate-usage-shape.test.ts.
 */
export function migrateLine(line: string): LineMigration {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ...NOOP(line), malformed: true };
  }

  // Event-format llm.response. Treat both `undefined` and `null` as
  // "no usage object yet" so a hypothetical partial-migration record
  // (`usage: null`) gets re-migrated rather than skipped — `typeof null`
  // is `"object"`, which the naive check would accept.
  if (
    parsed.type === "llm.response" &&
    (parsed.usage == null || typeof parsed.usage !== "object")
  ) {
    const flatInput = typeof parsed.inputTokens === "number" ? parsed.inputTokens : 0;
    const flatOutput = typeof parsed.outputTokens === "number" ? parsed.outputTokens : 0;
    const flatCacheRead =
      typeof parsed.cacheReadTokens === "number" ? parsed.cacheReadTokens : 0;
    const flatCacheCreate =
      typeof parsed.cacheCreationTokens === "number" ? parsed.cacheCreationTokens : 0;
    const flatReasoning =
      typeof parsed.reasoningTokens === "number" ? parsed.reasoningTokens : 0;

    // Skip if there's nothing to migrate (event was always blank).
    const hasAnyFlat =
      flatInput || flatOutput || flatCacheRead || flatCacheCreate || flatReasoning;
    if (!hasAnyFlat) return NOOP(line);

    const usage: Record<string, number> = {
      inputTokens: flatInput,
      outputTokens: flatOutput,
    };
    if (flatCacheRead > 0) usage.cacheReadTokens = flatCacheRead;
    if (flatCacheCreate > 0) usage.cacheWriteTokens = flatCacheCreate;
    if (flatReasoning > 0) usage.reasoningTokens = flatReasoning;

    const next: Record<string, unknown> = { ...parsed, usage };
    delete next.inputTokens;
    delete next.outputTokens;
    delete next.cacheReadTokens;
    delete next.cacheCreationTokens;
    delete next.reasoningTokens;
    return { ...NOOP(JSON.stringify(next)), rewroteEvent: true };
  }

  // Legacy StoredMessage assistant.metadata
  if (parsed.role === "assistant" && parsed.metadata && typeof parsed.metadata === "object") {
    const meta = parsed.metadata as Record<string, unknown>;
    const hasFlat =
      typeof meta.inputTokens === "number" ||
      typeof meta.outputTokens === "number" ||
      typeof meta.cacheReadTokens === "number";
    const hasCostUsd = typeof meta.costUsd === "number";
    // Tighten against `usage: null` masquerading as a real object —
    // typeof null is "object", which would wrongly skip migration.
    const alreadyHasUsage = meta.usage != null && typeof meta.usage === "object";

    if (!hasFlat && !hasCostUsd) return NOOP(line);

    const newMeta = { ...meta };
    let rewroteMessage = false;
    let droppedCostUsd = false;

    if (hasFlat && !alreadyHasUsage) {
      const usage: Record<string, number> = {
        inputTokens: typeof meta.inputTokens === "number" ? meta.inputTokens : 0,
        outputTokens: typeof meta.outputTokens === "number" ? meta.outputTokens : 0,
      };
      if (typeof meta.cacheReadTokens === "number" && meta.cacheReadTokens > 0) {
        usage.cacheReadTokens = meta.cacheReadTokens;
      }
      newMeta.usage = usage;
      delete newMeta.inputTokens;
      delete newMeta.outputTokens;
      delete newMeta.cacheReadTokens;
      rewroteMessage = true;
    } else if (hasFlat && alreadyHasUsage) {
      // Both shapes present (partial prior migration?) — drop the flat
      // fields and trust the existing usage struct.
      delete newMeta.inputTokens;
      delete newMeta.outputTokens;
      delete newMeta.cacheReadTokens;
      rewroteMessage = true;
    }

    if (hasCostUsd) {
      delete newMeta.costUsd;
      droppedCostUsd = true;
    }

    const next = { ...parsed, metadata: newMeta };
    return { ...NOOP(JSON.stringify(next)), rewroteMessage, droppedCostUsd };
  }

  return NOOP(line);
}

function migrateFile(path: string, args: Args): FileResult {
  const result: FileResult = {
    path,
    scanned: 0,
    rewrittenEvents: 0,
    rewrittenMessages: 0,
    droppedCostUsd: 0,
    skipped: false,
    malformedLines: 0,
  };

  const content = readFileSync(path, "utf-8");
  const lines = content.split("\n");

  // Preserve the trailing newline marker so the rewritten file has the
  // same shape as the original (last element after split is "" when the
  // file ended with \n).
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  const dataLines = trailingNewline ? lines.slice(0, -1) : lines;

  if (dataLines.length === 0) {
    result.skipped = true;
    return result;
  }

  // Line 1 is conversation metadata — always preserved as-is. We don't
  // touch the (now-dead) totalInputTokens / totalOutputTokens / totalCostUsd
  // fields; they're harmless on disk and the readers ignore them.
  const out: string[] = [dataLines[0]!];

  for (let i = 1; i < dataLines.length; i++) {
    const line = dataLines[i]!;
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    result.scanned++;
    const m = migrateLine(line);
    out.push(m.text);
    if (m.rewroteEvent) result.rewrittenEvents++;
    if (m.rewroteMessage) result.rewrittenMessages++;
    if (m.droppedCostUsd) result.droppedCostUsd++;
    if (m.malformed) result.malformedLines++;
  }

  const changed =
    result.rewrittenEvents > 0 || result.rewrittenMessages > 0 || result.droppedCostUsd > 0;
  if (!changed) {
    result.skipped = true;
    return result;
  }

  if (args.dryRun) return result;

  const newContent = out.join("\n") + (trailingNewline ? "\n" : "");

  if (args.backup) {
    const backupPath = `${path}.bak`;
    if (!existsSync(backupPath)) {
      writeFileSync(backupPath, content);
    }
  }

  // Atomic rewrite: tmp + rename.
  const tmpPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, newContent);
  renameSync(tmpPath, path);

  return result;
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.dir)) {
    console.error(`Conversations directory not found: ${args.dir}`);
    process.exit(1);
  }

  // Self-heal: a SIGKILL between writeFileSync(tmp) and renameSync(tmp, path)
  // leaves an orphan `<file>.jsonl.tmp.<pid>.<ts>` that subsequent runs would
  // accumulate. Sweep them at startup so the working directory stays clean.
  // Pattern is anchored on the matching `.jsonl` suffix to avoid touching
  // unrelated tmp files a user might have parked in the dir.
  const orphans = readdirSync(args.dir).filter((f) => /\.jsonl\.tmp\.\d+\.\d+$/.test(f));
  for (const f of orphans) {
    try {
      unlinkSync(join(args.dir, f));
      if (args.verbose) console.error(`  · removed orphan tmp: ${f}`);
    } catch {
      // Best-effort — a concurrent run may have already cleaned it.
    }
  }

  const filenames = readdirSync(args.dir).filter((f) => f.endsWith(".jsonl"));

  console.error(`migrate-usage-shape: scanning ${filenames.length} files in ${args.dir}`);
  console.error(
    `  mode: ${args.dryRun ? "DRY-RUN (no writes)" : "write"}, backup: ${args.backup ? "on" : "off"}`,
  );
  console.error("");

  const totals = {
    files: filenames.length,
    filesChanged: 0,
    filesSkipped: 0,
    rewrittenEvents: 0,
    rewrittenMessages: 0,
    droppedCostUsd: 0,
    malformedLines: 0,
  };

  for (const filename of filenames) {
    const path = join(args.dir, filename);
    let result: FileResult;
    try {
      result = migrateFile(path, args);
    } catch (err) {
      console.error(`  ! ${filename}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (result.skipped) {
      totals.filesSkipped++;
      if (args.verbose) {
        console.error(`  · ${filename}: no changes`);
      }
      continue;
    }

    totals.filesChanged++;
    totals.rewrittenEvents += result.rewrittenEvents;
    totals.rewrittenMessages += result.rewrittenMessages;
    totals.droppedCostUsd += result.droppedCostUsd;
    totals.malformedLines += result.malformedLines;

    const parts: string[] = [];
    if (result.rewrittenEvents) parts.push(`${result.rewrittenEvents} events`);
    if (result.rewrittenMessages) parts.push(`${result.rewrittenMessages} messages`);
    if (result.droppedCostUsd) parts.push(`${result.droppedCostUsd} costUsd dropped`);
    if (result.malformedLines)
      parts.push(`${result.malformedLines} malformed (preserved)`);
    console.error(`  ✓ ${filename}: ${parts.join(", ")}`);
  }

  console.error("");
  console.error(`Done. Files: ${fmt(totals.filesChanged)} changed, ${fmt(totals.filesSkipped)} unchanged.`);
  console.error(
    `  Events rewritten:    ${fmt(totals.rewrittenEvents)} (flat → usage:{...})`,
  );
  console.error(
    `  Messages rewritten:  ${fmt(totals.rewrittenMessages)} (metadata.{flat} → metadata.usage)`,
  );
  console.error(`  costUsd dropped:     ${fmt(totals.droppedCostUsd)}`);
  if (totals.malformedLines > 0) {
    console.error(
      `  Malformed lines:     ${fmt(totals.malformedLines)} (left in place, not rewritten)`,
    );
  }
  if (args.dryRun) {
    console.error("");
    console.error("DRY-RUN — no files were modified. Re-run without --dry-run to apply.");
  } else if (args.backup && totals.filesChanged > 0) {
    console.error("");
    console.error(`Backups written as <conversation>.jsonl.bak. Delete after verifying totals.`);
  }
}

// Only run when invoked as the CLI entry. Importing the module (e.g.
// from a unit test of `migrateLine`) doesn't trigger the migration.
if (import.meta.main) {
  main();
}
