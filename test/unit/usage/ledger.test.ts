/**
 * The ledger writer and its layout helpers.
 *
 * The retention sweep is the part worth the most care: it is the only code in
 * this subsystem that *deletes*, it runs unattended at every boot, and its
 * failure mode is silent — a month that should have been kept is simply gone
 * the next time anyone looks.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oldestRetainedMonth, UsageLedger } from "../../../src/usage/ledger.ts";
import {
  usageMonthDir,
  usageMonthOf,
  usageMonthsInRange,
  usageShardPath,
} from "../../../src/usage/paths.ts";
import type { UsageLedgerEntry } from "../../../src/usage/types.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nb-ledger-unit-"));
}

function entry(over: Partial<UsageLedgerEntry> = {}): UsageLedgerEntry {
  return {
    ts: "2026-04-10T12:00:00Z",
    source: "main",
    origin: "chat",
    model: "anthropic:claude-sonnet-4-5-20250929",
    usage: { inputTokens: 10, outputTokens: 5 },
    llmMs: 1,
    ...over,
  };
}

/** Seed `months` as ledger directories with a line each. */
function seedMonths(dir: string, months: string[]): void {
  for (const m of months) {
    mkdirSync(usageMonthDir(dir, m), { recursive: true });
    writeFileSync(usageShardPath(dir, m, "seed"), `${JSON.stringify(entry())}\n`);
  }
}

describe("UsageLedger.append", () => {
  test("writes one line to the month the call belongs to", () => {
    const dir = tmp();
    new UsageLedger(dir, "inst-1", { retentionMonths: 0 }).append(entry());

    const path = usageShardPath(dir, "2026-04", "inst-1");
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] as string) as UsageLedgerEntry).model).toContain("sonnet");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a call in another month lands in that month's partition", () => {
    const dir = tmp();
    const ledger = new UsageLedger(dir, "inst-1", { retentionMonths: 0 });
    ledger.append(entry({ ts: "2026-04-30T23:59:59Z" }));
    ledger.append(entry({ ts: "2026-05-01T00:00:00Z" }));

    expect(existsSync(usageShardPath(dir, "2026-04", "inst-1"))).toBe(true);
    expect(existsSync(usageShardPath(dir, "2026-05", "inst-1"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unwritable work dir does not throw — a dropped line beats a broken turn", () => {
    // `/dev/null/...` can never be created. Recording must degrade to an
    // undercount, which is the failure the ledger already exists to reduce;
    // throwing here would take down the call that was being recorded.
    const ledger = new UsageLedger("/dev/null/nope", "inst-1", { retentionMonths: 0 });
    expect(() => ledger.append(entry())).not.toThrow();
  });

  test("disabled writes nothing", () => {
    const dir = tmp();
    new UsageLedger(dir, "inst-1", { enabled: false }).append(entry());
    expect(existsSync(usageMonthDir(dir, "2026-04"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("UsageLedger retention sweep", () => {
  test("deletes months older than the window and keeps the rest", () => {
    const dir = tmp();
    const now = new Date();
    const monthsAgo = (n: number): string => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      d.setUTCMonth(d.getUTCMonth() - n);
      return usageMonthOf(d);
    };
    const [current, old, ancient] = [monthsAgo(0), monthsAgo(3), monthsAgo(30)];
    seedMonths(dir, [current, old, ancient] as string[]);

    new UsageLedger(dir, "inst-1", { retentionMonths: 24 });

    expect(existsSync(usageMonthDir(dir, current as string))).toBe(true);
    expect(existsSync(usageMonthDir(dir, old as string))).toBe(true);
    expect(existsSync(usageMonthDir(dir, ancient as string))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps the month at the exact edge of the window", () => {
    // The regression: month arithmetic that preserves the day-of-month rolls a
    // 31st into the following month, moving the cutoff a month later and taking
    // a directory that was still inside retention. Boundary months are where
    // that shows, so this seeds exactly the edge.
    const dir = tmp();
    const now = new Date();
    const edge = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    edge.setUTCMonth(edge.getUTCMonth() - 12);
    seedMonths(dir, [usageMonthOf(edge)]);

    new UsageLedger(dir, "inst-1", { retentionMonths: 12 });

    expect(existsSync(usageMonthDir(dir, usageMonthOf(edge)))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("retentionMonths 0 keeps everything", () => {
    const dir = tmp();
    seedMonths(dir, ["2019-01"]);
    new UsageLedger(dir, "inst-1", { retentionMonths: 0 });
    expect(existsSync(usageMonthDir(dir, "2019-01"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("leaves directories that are not month partitions alone", () => {
    const dir = tmp();
    seedMonths(dir, ["2019-01"]);
    mkdirSync(join(dir, "usage", "notes"), { recursive: true });
    new UsageLedger(dir, "inst-1", { retentionMonths: 1 });
    // A name that does not parse is not evidence of an expired month, so it is
    // left rather than deleted on a failed parse.
    expect(existsSync(join(dir, "usage", "notes"))).toBe(true);
    expect(existsSync(usageMonthDir(dir, "2019-01"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("oldestRetainedMonth", () => {
  // The dates that matter are the ones where the day-of-month does not exist in
  // the target month. `setUTCMonth` alone rolls those forward, moving the cutoff
  // a month later and taking a directory still inside the window.
  test("a 31st does not roll forward into the next month", () => {
    expect(oldestRetainedMonth(new Date("2026-03-31T00:00:00Z"), 1)).toBe("2026-02");
  });

  test("a leap day does not roll forward at the default window", () => {
    expect(oldestRetainedMonth(new Date("2028-02-29T00:00:00Z"), 24)).toBe("2026-02");
  });

  test("a 31st stepping into another 31-day month is unaffected", () => {
    expect(oldestRetainedMonth(new Date("2026-03-31T00:00:00Z"), 2)).toBe("2026-01");
  });

  test("crosses a year boundary", () => {
    expect(oldestRetainedMonth(new Date("2026-01-15T00:00:00Z"), 3)).toBe("2025-10");
  });
});

describe("usageMonthsInRange", () => {
  test("covers both endpoints", () => {
    expect(usageMonthsInRange("2026-04-10", "2026-04-20")).toEqual(["2026-04"]);
    expect(usageMonthsInRange("2026-04-10", "2026-06-02")).toEqual(["2026-04", "2026-05", "2026-06"]);
  });

  test("crosses a year boundary", () => {
    expect(usageMonthsInRange("2025-11-15", "2026-02-01")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  test("an unparseable range yields nothing rather than throwing", () => {
    expect(usageMonthsInRange("not-a-date", "2026-01-01")).toEqual([]);
  });
});
