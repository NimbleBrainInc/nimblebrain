/**
 * The durable half of the spend chokepoint: one JSONL line per priced LLM call.
 *
 * Usage was previously *derived* from a storage side effect — a conversation
 * file happening to exist, in a workspace still on disk — so any call path that
 * did not write one was invisible, and four such paths existed. A line here is
 * recorded at the point of spend instead, which is what makes the fifth such
 * path visible without anyone remembering to wire it up.
 *
 * **This is not `api/metrics.ts`.** That module is process-local and
 * side-effect-free on import, which is why it is safe to wire in anywhere; a
 * synchronous disk append would take that property away from every caller. The
 * counters stay there and the durable record lives here, both reached through
 * `record.ts`.
 *
 * **Invariant, load-bearing for the reader:** the ledger is the sole source for
 * tenant-level spend, and conversation `llm.response` usage is the sole source
 * for per-conversation display. Neither reader may sum the other's source, or
 * every call that has both lands in the total twice.
 *
 * Writes are best-effort and never throw: a dropped line is an undercount, and
 * undercounting is the failure mode already being fixed — it cannot be made
 * worse by trying. A write that breaks a turn would be.
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "../observability/log.ts";
import {
  usageInstanceId,
  usageMonthDir,
  usageMonthOf,
  usageRoot,
  usageShardPath,
} from "./paths.ts";
import type { UsageLedgerEntry } from "./types.ts";

/** Config for the durable ledger, mirrored in `nimblebrain-config.schema.json`. */
export interface UsageLedgerConfig {
  /** Default true. False disables the write path entirely; the reader still reads. */
  enabled?: boolean;
  /** Months of history to keep. Default 24; 0 keeps everything. */
  retentionMonths?: number;
}

/**
 * Appends priced calls to `{workDir}/usage/<YYYY-MM>/<instance>.jsonl`.
 *
 * One instance per process, constructed by the runtime and handed to
 * `record.ts`. Holding it rather than resolving paths per call is what lets the
 * boot id stay fixed for the process's life, which is the property that makes
 * a same-host restart take a fresh shard.
 */
export class UsageLedger {
  private readonly enabled: boolean;
  /** Month dirs already created this process, so the common append skips mkdir. */
  private readonly ensured = new Set<string>();
  /** Logged once — a broken ledger must not narrate on every call. */
  private warned = false;

  constructor(
    private readonly workDir: string,
    private readonly instance: string,
    config: UsageLedgerConfig = {},
  ) {
    this.enabled = config.enabled !== false;
    if (this.enabled) this.sweepExpired(config.retentionMonths ?? 24);
  }

  /** Append one call. Never throws. */
  append(entry: UsageLedgerEntry): void {
    if (!this.enabled) return;
    try {
      const month = usageMonthOf(entry.ts);
      const path = usageShardPath(this.workDir, month, this.instance);
      if (!this.ensured.has(month)) {
        mkdirSync(dirname(path), { recursive: true });
        this.ensured.add(month);
      }
      appendFileSync(path, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        log.warn(
          "[usage] ledger append failed; spend for this process is undercounted until it recovers",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  }

  /**
   * Delete month directories older than the retention window.
   *
   * Swept at construction only, matching `WorkspaceLogSink` — there is no
   * existing periodic timer to reuse, and introducing one for a directory that
   * grows at tens of megabytes a year buys nothing. The stated consequence: a
   * process that outlives `retentionMonths` never sweeps the month that expires
   * during its life, and sweeps it on the next restart instead.
   */
  private sweepExpired(retentionMonths: number): void {
    if (retentionMonths <= 0) return;
    try {
      const oldest = oldestRetainedMonth(new Date(), retentionMonths);
      for (const name of readdirSync(usageRoot(this.workDir))) {
        // Lexical comparison is chronological for `YYYY-MM`, and non-conforming
        // names sort clear of it rather than being deleted on a parse failure.
        if (/^\d{4}-\d{2}$/.test(name) && name < oldest) {
          rmSync(usageMonthDir(this.workDir, name), { recursive: true, force: true });
        }
      }
    } catch {
      // No ledger root yet on first boot, which is the common case.
    }
  }
}

/**
 * The oldest month the window keeps — anything strictly before it is expired.
 *
 * Pure, and takes `now`, because the bug this replaced could not be tested
 * otherwise: `setUTCMonth` preserves the day-of-month, so stepping back from a
 * 31st into a 30-day month rolls *forward* into the next one and moves the
 * cutoff a month later — deleting a directory still inside the window. It only
 * bites on days that do not exist in the target month, so a test run on the 8th
 * of anything would never see it. Anchoring to the 1st first is the fix.
 */
export function oldestRetainedMonth(now: Date, retentionMonths: number): string {
  const cutoff = new Date(now);
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - retentionMonths);
  return usageMonthOf(cutoff);
}

/**
 * The process's ledger, with a fresh shard id.
 *
 * The boot id is minted here rather than by the caller so the "one writer per
 * file, even across a same-host restart" property lives with the layout it
 * protects instead of at a composition root that could forget it.
 */
export function createProcessLedger(workDir: string, config?: UsageLedgerConfig): UsageLedger {
  return new UsageLedger(workDir, usageInstanceId(crypto.randomUUID().slice(0, 8)), config ?? {});
}
