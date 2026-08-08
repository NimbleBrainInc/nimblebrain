/**
 * The single sanctioned construction and parse site for the usage ledger's
 * on-disk layout, mirroring `src/conversation/paths.ts` for conversations.
 *
 *   {workDir}/usage/<YYYY-MM>/<instance>.jsonl
 *
 * **Month-partitioned** so retention is a directory delete rather than a
 * rewrite, and a period query opens only the months it spans.
 *
 * **Instance-sharded** so there is exactly one writer per file. Multi-replica
 * is a documented roadmap item rather than a shipped one, but relying on POSIX
 * `O_APPEND` atomicity across an RWX volume is the kind of assumption that
 * holds until it doesn't, and removing the concern before it exists costs one
 * path segment. The shard id includes a per-process boot id so two runs on the
 * same host never share a file either.
 */

import { join } from "node:path";

const USAGE_SEGMENT = "usage";

/** `YYYY-MM`, the month partition a timestamp belongs to. */
export function usageMonthOf(ts: string | Date): string {
  const d = typeof ts === "string" ? new Date(ts) : ts;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

/** `{workDir}/usage` — the ledger root. */
export function usageRoot(workDir: string): string {
  return join(workDir, USAGE_SEGMENT);
}

/** `{workDir}/usage/<YYYY-MM>` — one month's shards. */
export function usageMonthDir(workDir: string, month: string): string {
  return join(usageRoot(workDir), month);
}

/** `{workDir}/usage/<YYYY-MM>/<instance>.jsonl` — one writer's shard. */
export function usageShardPath(workDir: string, month: string, instance: string): string {
  return join(usageMonthDir(workDir, month), `${instance}.jsonl`);
}

/**
 * The months a date range spans, inclusive, oldest first.
 *
 * Iterates by month rather than by day so a year-long range costs twelve steps,
 * and crosses year boundaries because it counts in months since epoch rather
 * than incrementing a month field.
 */
export function usageMonthsInRange(from: string, to: string): string[] {
  const start = new Date(`${from.slice(0, 10)}T00:00:00Z`);
  const end = new Date(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const months: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
  while (cursor.getTime() <= last) {
    months.push(usageMonthOf(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

/**
 * `<hostname>-<bootId>` — this process's shard name, stable for its lifetime.
 *
 * The boot id is what makes a same-host restart take a fresh file instead of
 * reopening one whose tail another process may still be writing.
 */
export function usageInstanceId(bootId: string): string {
  const host = process.env.HOSTNAME ?? "local";
  return `${host}-${bootId}`;
}

/** True for a shard written by the backfill script rather than a live writer. */
export function isBackfillShard(filename: string): boolean {
  return filename === "backfill.jsonl";
}

/** The backfill script's shard for one month — rewritten wholesale on each run. */
export function usageBackfillPath(workDir: string, month: string): string {
  return join(usageMonthDir(workDir, month), "backfill.jsonl");
}
