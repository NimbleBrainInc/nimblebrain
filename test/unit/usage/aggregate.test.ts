import { afterAll, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateUsage,
  computeCacheHitRate,
  resolveDateRange,
} from "../../../src/usage/aggregate.ts";
import { MAX_BREAKDOWN_ROWS } from "../../../src/usage/aggregate.ts";
import { estimateCost, resolveRates } from "../../../src/usage/cost.ts";
import { usageMonthDir, usageMonthOf } from "../../../src/usage/paths.ts";
import type { UsageLedgerEntry } from "../../../src/usage/types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nb-usage-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Write calls to the ledger under `dir`, attributed to one session.
 *
 * These tests are about the aggregation — date filtering, cache-hit rate,
 * owner scoping, breakdown shape — and that is unchanged. What changed beneath
 * them is the source: spend is read from `{workDir}/usage/<YYYY-MM>/*.jsonl`
 * rather than scanned out of conversation logs, so the fixture writes the
 * former. `session` and `ownerId` stand in for what a conversation file used
 * to supply from its metadata line and its path.
 */
function writeCalls(
  dir: string,
  meta: { id: string; ownerId?: string; origin?: "chat" | "task" },
  events: Record<string, unknown>[] = [],
): void {
  const byMonth = new Map<string, string[]>();
  for (const e of events) {
    const ev = e as { ts: string; model: string; usage: Record<string, number>; llmMs?: number };
    const rates = resolveRates(ev.model);
    const entry: UsageLedgerEntry = {
      ts: ev.ts,
      source: "main",
      origin: meta.origin ?? "chat",
      delegated: false,
      model: ev.model,
      usage: ev.usage as UsageLedgerEntry["usage"],
      llmMs: ev.llmMs ?? 0,
      sessionId: meta.id,
      ...(meta.ownerId !== undefined ? { userId: meta.ownerId } : {}),
      ...(rates ? { rates } : {}),
    };
    const month = usageMonthOf(entry.ts);
    const lines = byMonth.get(month) ?? [];
    lines.push(JSON.stringify(entry));
    byMonth.set(month, lines);
  }
  for (const [month, lines] of byMonth) {
    const monthDir = usageMonthDir(dir, month);
    mkdirSync(monthDir, { recursive: true });
    // Appended, so several fixtures in one test share the month's shard.
    appendFileSync(join(monthDir, "test.jsonl"), `${lines.join("\n")}\n`);
  }
}

function llmEvent(overrides: Partial<{
  ts: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  llmMs: number;
}> = {}): Record<string, unknown> {
  return {
    type: "llm.response",
    ts: overrides.ts ?? "2026-04-10T12:00:00Z",
    model: overrides.model ?? "claude-sonnet-4-5-20250929",
    usage: {
      inputTokens: overrides.inputTokens ?? 1000,
      outputTokens: overrides.outputTokens ?? 500,
      cacheReadTokens: overrides.cacheReadTokens ?? 0,
      cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    },
    llmMs: overrides.llmMs ?? 200,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aggregateUsage", () => {
  it("aggregates tokens from llm.response events even when metadata has zero tokens", async () => {
    const dir = makeTmpDir();
    // Metadata has zero tokens (the old bug: event-sourced store never rewrites line 1)
    writeCalls(dir, 
      { id: "conv-1", updatedAt: "2026-04-10T14:00:00Z", totalInputTokens: 0, totalOutputTokens: 0 },
      [
        llmEvent({ inputTokens: 500, outputTokens: 200 }),
        llmEvent({ inputTokens: 300, outputTokens: 100 }),
      ],
    );

    const report = await aggregateUsage(dir, "all", "day");

    expect(report.totals.tokens.input).toBe(800);
    expect(report.totals.tokens.output).toBe(300);
    expect(report.totals.llmCalls).toBe(2);
    expect(report.totals.conversations).toBe(1);
  });

  it("counts aux.usage events (forked compaction/title calls) toward totals", async () => {
    const dir = makeTmpDir();
    writeCalls(dir, { id: "conv-aux", updatedAt: "2026-04-10T14:00:00Z" }, [
      llmEvent({ inputTokens: 1000, outputTokens: 500 }),
      {
        type: "aux.usage",
        ts: "2026-04-10T12:05:00Z",
        source: "compaction",
        model: "claude-haiku-4-5-20251001",
        usage: { inputTokens: 400, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0 },
        llmMs: 120,
      },
    ]);

    const report = await aggregateUsage(dir, "all", "day");

    // Both the main turn and the forked summarizer call are counted.
    expect(report.totals.tokens.input).toBe(1400);
    expect(report.totals.tokens.output).toBe(560);
    expect(report.totals.llmCalls).toBe(2);
  });

  it("filters usage by llm.response timestamp, not conversation updatedAt", async () => {
    const dir = makeTmpDir();

    // Conversation updated inside range, but its only LLM usage happened before
    // the report window. It should not make today's usage non-zero.
    writeCalls(dir, { id: "updated-today", updatedAt: "2026-04-12T10:00:00Z" }, [
        llmEvent({ ts: "2026-04-11T23:00:00Z", inputTokens: 9999, outputTokens: 9999 }),
      ]);

    const report = await aggregateUsage(dir, "day", "day", {
      from: "2026-04-12",
      to: "2026-04-12",
    });

    expect(report.totals.tokens.input).toBe(0);
    expect(report.totals.tokens.output).toBe(0);
    expect(report.totals.llmCalls).toBe(0);
    expect(report.totals.conversations).toBe(0);
    expect(report.models).toHaveLength(0);
    expect(report.breakdown).toHaveLength(1);
    expect(report.breakdown[0].key).toBe("2026-04-12");
    expect(report.breakdown[0].llmCalls).toBe(0);
  });

  it("counts in-range llm.response events even when conversation updatedAt is outside range", async () => {
    const dir = makeTmpDir();

    writeCalls(dir, { id: "updated-later", updatedAt: "2026-05-01T10:00:00Z" }, [
        llmEvent({ ts: "2026-04-10T12:00:00Z", inputTokens: 100, outputTokens: 50 }),
      ]);

    const report = await aggregateUsage(dir, "month", "day", {
      from: "2026-04-01",
      to: "2026-04-30",
    });

    expect(report.totals.tokens.input).toBe(100);
    expect(report.totals.tokens.output).toBe(50);
    expect(report.totals.llmCalls).toBe(1);
    expect(report.totals.conversations).toBe(1);
  });

  it("computes cost correctly from model catalog", async () => {
    const dir = makeTmpDir();
    // claude-sonnet-4-5-20250929: input=$3/M, output=$15/M, cacheRead=$0.30/M.
    // Cache writes bill at the 1-hour TTL rate the engine uses: 2x input = $6/M.
    // AI SDK V3 contract: inputTokens is grand total = noCache + cacheRead + cacheWrite.
    // So 2_000_000 total = 500K noCache + 500K cacheRead + 1M cacheWrite.
    writeCalls(dir, { id: "cost-conv", updatedAt: "2026-04-10T10:00:00Z" }, [
        llmEvent({
          model: "claude-sonnet-4-5-20250929",
          inputTokens: 2_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 500_000,
          cacheWriteTokens: 1_000_000,
        }),
      ]);

    const report = await aggregateUsage(dir, "all", "day");

    const cost = report.totals.cost;
    // Non-cached input = 2M - 500K - 1M = 500K. 500K * $3/M = $1.50.
    expect(cost.input).toBeCloseTo(1.5, 4);
    expect(cost.output).toBeCloseTo(15.0, 4);
    expect(cost.cacheRead).toBeCloseTo(0.15, 4);
    expect(cost.cacheWrite).toBeCloseTo(6.0, 4);
    expect(cost.total).toBeCloseTo(1.5 + 15.0 + 0.15 + 6.0, 4);

    // Token breakdown: input is the non-cached portion, not the grand total.
    expect(report.totals.tokens.input).toBe(500_000);
    expect(report.totals.tokens.cacheRead).toBe(500_000);
    expect(report.totals.tokens.cacheWrite).toBe(1_000_000);
    expect(report.totals.tokens.output).toBe(1_000_000);
  });

  it("groups by day correctly using event timestamp", async () => {
    const dir = makeTmpDir();

    writeCalls(dir, { id: "md", updatedAt: "2026-04-12T10:00:00Z" }, [
        llmEvent({ ts: "2026-04-10T08:00:00Z", inputTokens: 100, outputTokens: 50 }),
        llmEvent({ ts: "2026-04-10T09:00:00Z", inputTokens: 200, outputTokens: 100 }),
        llmEvent({ ts: "2026-04-11T10:00:00Z", inputTokens: 400, outputTokens: 200 }),
      ]);

    const report = await aggregateUsage(dir, "all", "day");

    expect(report.breakdown).toHaveLength(2);

    const day10 = report.breakdown.find((b) => b.key === "2026-04-10");
    const day11 = report.breakdown.find((b) => b.key === "2026-04-11");

    expect(day10).toBeDefined();
    expect(day10!.tokens.input).toBe(300);
    expect(day10!.tokens.output).toBe(150);
    expect(day10!.llmCalls).toBe(2);

    expect(day11).toBeDefined();
    expect(day11!.tokens.input).toBe(400);
    expect(day11!.tokens.output).toBe(200);
    expect(day11!.llmCalls).toBe(1);
  });

  it("returns empty report for empty directory", async () => {
    const dir = makeTmpDir();

    const report = await aggregateUsage(dir, "all", "day");

    expect(report.totals.tokens.input).toBe(0);
    expect(report.totals.tokens.output).toBe(0);
    expect(report.totals.llmCalls).toBe(0);
    expect(report.totals.conversations).toBe(0);
    expect(report.models).toHaveLength(0);
    expect(report.breakdown).toHaveLength(0);
  });

  it("returns empty report for non-existent directory", async () => {
    const report = await aggregateUsage("/tmp/does-not-exist-" + Date.now(), "all", "day");

    expect(report.totals.llmCalls).toBe(0);
    expect(report.totals.conversations).toBe(0);
  });

  it("zero-fills missing days in bounded period", async () => {
    const dir = makeTmpDir();
    writeCalls(dir, { id: "sp", updatedAt: "2026-04-12T10:00:00Z" }, [
        llmEvent({ ts: "2026-04-10T08:00:00Z", inputTokens: 100, outputTokens: 50 }),
        llmEvent({ ts: "2026-04-12T10:00:00Z", inputTokens: 200, outputTokens: 100 }),
      ]);

    const report = await aggregateUsage(dir, "week", "day", { from: "2026-04-10", to: "2026-04-12" });

    expect(report.breakdown).toHaveLength(3);
    expect(report.breakdown[0].key).toBe("2026-04-10");
    expect(report.breakdown[1].key).toBe("2026-04-11");
    expect(report.breakdown[1].llmCalls).toBe(0);
    expect(report.breakdown[2].key).toBe("2026-04-12");
  });

  it("returns multiple breakdown dimensions from one aggregation", async () => {
    const dir = makeTmpDir();
    writeCalls(dir, { id: "alice", updatedAt: "2026-04-12T10:00:00Z", ownerId: "usr_alice" }, [
        llmEvent({ ts: "2026-04-10T08:00:00Z", inputTokens: 100, outputTokens: 50 }),
        llmEvent({ ts: "2026-04-12T10:00:00Z", inputTokens: 200, outputTokens: 100 }),
      ]);
    writeCalls(dir, { id: "bob", updatedAt: "2026-04-11T10:00:00Z", ownerId: "usr_bob" }, [
        llmEvent({ ts: "2026-04-11T10:00:00Z", inputTokens: 400, outputTokens: 200 }),
      ]);

    const report = await aggregateUsage(dir, "week", ["user", "day"], {
      from: "2026-04-10",
      to: "2026-04-12",
    });

    expect(report.breakdown).toEqual(report.breakdowns.user);
    expect(report.breakdowns.user?.map((b) => b.key)).toEqual(["usr_alice", "usr_bob"]);
    expect(report.breakdowns.day?.map((b) => b.key)).toEqual([
      "2026-04-10",
      "2026-04-11",
      "2026-04-12",
    ]);
    expect(report.breakdowns.day?.[0].tokens.input).toBe(100);
    expect(report.breakdowns.day?.[1].tokens.input).toBe(400);
    expect(report.breakdowns.day?.[2].tokens.input).toBe(200);
    expect(report.totals.tokens.input).toBe(700);
    expect(report.totals.conversations).toBe(2);
  });

  it("aggregator cost.total matches estimateCost for the same inputs (drift guard)", async () => {
    // Regression: pre-fix, decomposeUsage's cost math diverged from
    // estimateCost on models with cost.reasoning. Today no catalog model
    // has that field so the values match by coincidence — pin the
    // equivalence so future divergence fails this test instead of
    // silently producing dashboard ≠ live-cost numbers.
    const dir = makeTmpDir();
    const usage = {
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 1_000_000,
      reasoningTokens: 200_000,
    };
    writeCalls(dir, { id: "drift", updatedAt: "2026-04-10T10:00:00Z" }, [
        llmEvent({
          model: "claude-sonnet-4-5-20250929",
          ...usage,
        }),
      ]);
    const report = await aggregateUsage(dir, "all", "day");
    const expectedTotal = estimateCost("claude-sonnet-4-5-20250929", usage);
    expect(report.totals.cost.total).toBeCloseTo(expectedTotal, 8);
  });

  it("UsageReport shape contract — pins the wire-format key set", async () => {
    // Regression: external consumers (web shell, dashboards) read fields
    // off this report. A silent rename here is what produced the
    // `cost.cacheCreation` → `cacheWrite` cross-package breakage that
    // crashed the web/src/pages/settings/UsageTab. Pin the exact key
    // set so any future rename fails this test instead of going
    // unnoticed until a UI panel throws on render.
    const dir = makeTmpDir();
    writeCalls(dir, { id: "shape", updatedAt: "2026-04-10T10:00:00Z" }, [
        llmEvent({
          model: "claude-sonnet-4-5-20250929",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 100,
          cacheWriteTokens: 200,
        }),
      ]);
    const report = await aggregateUsage(dir, "all", "day");

    // Top-level
    expect(Object.keys(report).sort()).toEqual([
      "breakdown",
      "breakdowns",
      "models",
      "period",
      "totals",
    ]);
    expect(report.breakdowns.day).toEqual(report.breakdown);

    // totals.tokens — exact bucket set; if a rename happens, this fails
    expect(Object.keys(report.totals.tokens).sort()).toEqual([
      "cacheRead",
      "cacheWrite",
      "input",
      "output",
    ]);

    // totals.cost — same buckets plus `total`
    expect(Object.keys(report.totals.cost).sort()).toEqual([
      "cacheRead",
      "cacheWrite",
      "input",
      "output",
      "total",
    ]);

    // models[] entry shape
    expect(report.models.length).toBeGreaterThan(0);
    const m = report.models[0]!;
    expect(Object.keys(m).sort()).toEqual(["cacheHitRate", "cost", "llmCalls", "model", "tokens"]);
    expect(Object.keys(m.tokens).sort()).toEqual(["cacheRead", "cacheWrite", "input", "output"]);
    expect(Object.keys(m.cost).sort()).toEqual([
      "cacheRead",
      "cacheWrite",
      "input",
      "output",
      "total",
    ]);

    // breakdown[] entry shape
    expect(report.breakdown.length).toBeGreaterThan(0);
    const b = report.breakdown[0]!;
    expect(Object.keys(b).sort()).toEqual([
      "cacheHitRate",
      "conversations",
      "cost",
      "key",
      "llmCalls",
      "tokens",
    ]);
  });

  it("computes the input-side cache-hit rate on totals, models, and breakdown", async () => {
    const dir = makeTmpDir();
    // One call: 1000 input total = 700 cacheRead + 200 cacheWrite + 100 non-cached.
    // hit rate = 700 / (100 + 700 + 200) = 0.7
    writeCalls(dir, { id: "hit", updatedAt: "2026-04-10T10:00:00Z" }, [
        llmEvent({
          model: "claude-sonnet-4-5-20250929",
          inputTokens: 1000,
          outputTokens: 10,
          cacheReadTokens: 700,
          cacheWriteTokens: 200,
        }),
      ]);
    const report = await aggregateUsage(dir, "all", "day");
    expect(report.totals.cacheHitRate).toBeCloseTo(0.7, 6);
    expect(report.models[0]!.cacheHitRate).toBeCloseTo(0.7, 6);
    expect(report.breakdown[0]!.cacheHitRate).toBeCloseTo(0.7, 6);
  });

  it("computeCacheHitRate is 0 when there are no input tokens", () => {
    expect(computeCacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// By-user aggregation + owner filter (org/audit surface)
// ---------------------------------------------------------------------------

describe("aggregateUsage — by user", () => {
  /** Two owners, three conversations: alice has two, bob has one. */
  function seedTwoOwners(dir: string): void {
    writeCalls(dir, { id: "alice-1", updatedAt: "2026-04-10T10:00:00Z", ownerId: "usr_alice" }, [
        llmEvent({ ts: "2026-04-10T10:00:00Z", inputTokens: 100, outputTokens: 50 }),
      ]);
    writeCalls(dir, { id: "alice-2", updatedAt: "2026-04-11T10:00:00Z", ownerId: "usr_alice" }, [
        llmEvent({ ts: "2026-04-11T10:00:00Z", inputTokens: 200, outputTokens: 100 }),
      ]);
    writeCalls(dir, { id: "bob-1", updatedAt: "2026-04-10T11:00:00Z", ownerId: "usr_bob" }, [
        llmEvent({ ts: "2026-04-10T11:00:00Z", inputTokens: 400, outputTokens: 200 }),
      ]);
  }

  it("groupBy:user buckets the breakdown by conversation owner", async () => {
    const dir = makeTmpDir();
    seedTwoOwners(dir);

    const report = await aggregateUsage(dir, "all", "user");

    expect(report.breakdown).toHaveLength(2);
    const alice = report.breakdown.find((b) => b.key === "usr_alice");
    const bob = report.breakdown.find((b) => b.key === "usr_bob");

    expect(alice).toBeDefined();
    // alice: 100 + 200 input, 50 + 100 output, 2 conversations, 2 calls
    expect(alice!.tokens.input).toBe(300);
    expect(alice!.tokens.output).toBe(150);
    expect(alice!.conversations).toBe(2);
    expect(alice!.llmCalls).toBe(2);

    expect(bob).toBeDefined();
    expect(bob!.tokens.input).toBe(400);
    expect(bob!.conversations).toBe(1);
    expect(bob!.llmCalls).toBe(1);

    // Org totals still span everyone.
    expect(report.totals.tokens.input).toBe(700);
    expect(report.totals.conversations).toBe(3);
  });

  it("ownerFilter restricts aggregation to one owner's conversations", async () => {
    const dir = makeTmpDir();
    seedTwoOwners(dir);

    const report = await aggregateUsage(dir, "all", "day", { ownerFilter: "usr_alice" });

    // Only alice's two conversations counted; bob's 400 input is excluded.
    expect(report.totals.tokens.input).toBe(300);
    expect(report.totals.tokens.output).toBe(150);
    expect(report.totals.conversations).toBe(2);
    expect(report.totals.llmCalls).toBe(2);
  });

  it("ownerFilter for an owner with no conversations yields an empty report", async () => {
    const dir = makeTmpDir();
    seedTwoOwners(dir);

    const report = await aggregateUsage(dir, "all", "user", { ownerFilter: "usr_nobody" });

    expect(report.totals.conversations).toBe(0);
    expect(report.totals.llmCalls).toBe(0);
    expect(report.breakdown).toHaveLength(0);
  });

  it("conversations missing ownerId bucket under 'unknown' for groupBy:user", async () => {
    const dir = makeTmpDir();
    // No ownerId on line 1 (legacy/corrupt) — still counted, bucketed as unknown.
    writeCalls(dir, { id: "legacy", updatedAt: "2026-04-10T10:00:00Z" }, [
        llmEvent({ ts: "2026-04-10T10:00:00Z", inputTokens: 100, outputTokens: 50 }),
      ]);

    const report = await aggregateUsage(dir, "all", "user");

    expect(report.breakdown).toHaveLength(1);
    expect(report.breakdown[0]!.key).toBe("unknown");
    expect(report.breakdown[0]!.tokens.input).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// resolveDateRange — timezone safety
// ---------------------------------------------------------------------------

describe("resolveDateRange", () => {
  it("'month' range starts on the 1st regardless of timezone", () => {
    // Bug: new Date("2026-04-30") in PDT = April 29 local.
    // setDate(1) then gives March 1 local → "2026-03-02" UTC.
    // Correct: from should always be "2026-04-01".
    const range = resolveDateRange("month", undefined, "2026-04-30");
    expect(range.from).toBe("2026-04-01");
    expect(range.to).toBe("2026-04-30");
  });

  it("'month' range correct for January (no year rollback)", () => {
    const range = resolveDateRange("month", undefined, "2026-01-15");
    expect(range.from).toBe("2026-01-01");
    expect(range.to).toBe("2026-01-15");
  });

  it("'week' range subtracts exactly 7 days", () => {
    const range = resolveDateRange("week", undefined, "2026-04-30");
    expect(range.from).toBe("2026-04-23");
    expect(range.to).toBe("2026-04-30");
  });

  it("'week' range across month boundary", () => {
    const range = resolveDateRange("week", undefined, "2026-05-03");
    expect(range.from).toBe("2026-04-26");
    expect(range.to).toBe("2026-05-03");
  });

  it("'day' range returns same date for from and to", () => {
    const range = resolveDateRange("day", undefined, "2026-04-30");
    expect(range.from).toBe("2026-04-30");
    expect(range.to).toBe("2026-04-30");
  });

  it("explicit from/to passed through unchanged", () => {
    const range = resolveDateRange("month", "2026-03-01", "2026-04-30");
    expect(range.from).toBe("2026-03-01");
    expect(range.to).toBe("2026-04-30");
  });
});

describe("breakdown rows make the same split as totals", () => {
  it("counts a task run under runs, not conversations, in every row", async () => {
    const dir = makeTmpDir();
    writeCalls(dir, { id: "conv_1", ownerId: "usr_a" }, [llmEvent({ inputTokens: 10 })]);
    writeCalls(dir, { id: "run_1", ownerId: "usr_a", origin: "task" }, [
      llmEvent({ inputTokens: 20 }),
    ]);

    const report = await aggregateUsage(dir, "all", "day");

    // The defect this pins: totals split the two and the rows did not, so one
    // payload disagreed with itself and the UI's conversations column read 2.
    expect(report.totals.conversations).toBe(1);
    expect(report.totals.runs).toBe(1);
    const row = report.breakdown[0];
    expect(row?.conversations).toBe(1);
    expect(row?.runs).toBe(1);
  });

  it("reports unpriced calls per row, not only in totals", async () => {
    const dir = makeTmpDir();
    writeCalls(dir, { id: "run_1", origin: "task" }, [
      llmEvent({ model: "unknown-model-xyz", inputTokens: 100 }),
    ]);

    const report = await aggregateUsage(dir, "all", "day");
    expect(report.totals.unpricedCalls).toBe(1);
    expect(report.breakdown[0]?.unpricedCalls).toBe(1);
  });

  it("groups by origin and by provider", async () => {
    const dir = makeTmpDir();
    writeCalls(dir, { id: "conv_1" }, [llmEvent({ model: "nebius:zai-org/GLM-5.1" })]);
    writeCalls(dir, { id: "run_1", origin: "task" }, [llmEvent({ model: "anthropic:claude-x" })]);

    const byOrigin = await aggregateUsage(dir, "all", "origin");
    expect(byOrigin.breakdown.map((b) => b.key).sort()).toEqual(["chat", "task"]);

    const byProvider = await aggregateUsage(dir, "all", "provider");
    expect(byProvider.breakdown.map((b) => b.key).sort()).toEqual(["anthropic", "nebius"]);
  });
});

// ---------------------------------------------------------------------------
// The id split: new-shape records, legacy records, and the two mixed
// ---------------------------------------------------------------------------

/** Write one record in whichever shape the caller spells out. */
function writeRecord(dir: string, fields: Partial<UsageLedgerEntry>): void {
  const entry: UsageLedgerEntry = {
    ts: "2026-04-10T12:00:00Z",
    source: "main",
    origin: "chat",
    delegated: false,
    model: "claude-sonnet-4-5-20250929",
    usage: { inputTokens: 1000, outputTokens: 500 },
    llmMs: 200,
    ...fields,
  } as UsageLedgerEntry;
  const monthDir = usageMonthDir(dir, usageMonthOf(entry.ts));
  mkdirSync(monthDir, { recursive: true });
  appendFileSync(join(monthDir, "test.jsonl"), `${JSON.stringify(entry)}\n`);
}

describe("the ledger's id split", () => {
  // Every OTHER test in this file writes the legacy `sessionId` shape, so the
  // back-compat read is already under test by the whole suite above. These
  // cover the new shape, and the mixture that a retention window spanning the
  // split actually contains.

  it("counts a new-shape chat record as a conversation", async () => {
    const dir = makeTmpDir();
    writeRecord(dir, { conversationId: "conv_new", runId: "turn-1" });

    const report = await aggregateUsage(dir, "all", "day");
    expect(report.totals.conversations).toBe(1);
    expect(report.totals.runs ?? 0).toBe(0);
  });

  it("counts a new-shape automation record as a run, not a conversation", async () => {
    const dir = makeTmpDir();
    writeRecord(dir, { origin: "task", taskRunId: "run_new", runId: "turn-1" });

    const report = await aggregateUsage(dir, "all", "day");
    expect(report.totals.runs).toBe(1);
    expect(report.totals.conversations).toBe(0);
  });

  it("does not double-count one conversation written in both shapes", async () => {
    // The mixture inside one retention window: the same conversation before
    // and after the split. Both spellings must resolve to one id, or every
    // conversation straddling the change reads as two.
    const dir = makeTmpDir();
    writeRecord(dir, { sessionId: "conv_same" });
    writeRecord(dir, { conversationId: "conv_same", runId: "turn-2" });

    const report = await aggregateUsage(dir, "all", "day");
    expect(report.totals.conversations).toBe(1);
  });

  it("counts legacy and new automation records as one run", async () => {
    const dir = makeTmpDir();
    writeRecord(dir, { origin: "task", sessionId: "run_same" });
    writeRecord(dir, { origin: "task", taskRunId: "run_same", runId: "turn-2" });

    const report = await aggregateUsage(dir, "all", "day");
    expect(report.totals.runs).toBe(1);
  });

  it("keeps an automation out of the conversation breakdown", async () => {
    // The defect the undiscriminated read had: a task's run id keyed a row in
    // a dimension the schema calls "conversation", so a usage report listed
    // `run_…` among its conversations.
    const dir = makeTmpDir();
    writeRecord(dir, { origin: "task", taskRunId: "run_x", runId: "turn-1" });
    writeRecord(dir, { conversationId: "conv_x", runId: "turn-2" });

    const report = await aggregateUsage(dir, "all", "conversation");
    const keys = (report.breakdowns.conversation ?? []).map((r) => r.key);
    expect(keys).toContain("conv_x");
    expect(keys).not.toContain("run_x");
  });

  it("groups by turn — the grain the single field could not express", async () => {
    // Two turns of ONE conversation. Grouped by conversation this is a single
    // row and the per-turn split is unrecoverable; that is the whole reason
    // the engine's run id is now recorded.
    const dir = makeTmpDir();
    writeRecord(dir, { conversationId: "conv_multi", runId: "turn-a" });
    writeRecord(dir, { conversationId: "conv_multi", runId: "turn-b" });

    const report = await aggregateUsage(dir, "all", "turn");
    const rows = report.breakdowns.turn ?? [];
    expect(rows.map((r) => r.key).sort()).toEqual(["turn-a", "turn-b"]);
    expect(report.totals.conversations).toBe(1);
  });

  it("bills a delegated sub-agent to the turn that spawned it", async () => {
    // A sub-agent runs its own engine and mints its own `runId`, so keying the
    // dimension on that alone splits one turn into a row per agent — the
    // parent understating what the turn cost, and children sitting beside
    // top-level turns with nothing to tell them apart. `parentRunId` is the
    // TOP-LEVEL run at any depth, so it rolls the whole subtree back up.
    const dir = makeTmpDir();
    writeRecord(dir, { conversationId: "conv_d", runId: "turn-top" });
    writeRecord(dir, {
      conversationId: "conv_d",
      runId: "child-1",
      parentRunId: "turn-top",
      delegated: true,
    });
    writeRecord(dir, {
      conversationId: "conv_d",
      runId: "grandchild-1",
      parentRunId: "turn-top",
      delegated: true,
    });

    const report = await aggregateUsage(dir, "all", "turn");
    const rows = report.breakdowns.turn ?? [];
    expect(rows.map((r) => r.key)).toEqual(["turn-top"]);
    // The whole turn's spend, not the top-level agent's share of it.
    expect(rows[0]!.llmCalls).toBe(3);
    expect(rows[0]!.cost.total).toBeCloseTo(report.totals.cost.total, 10);
  });

  it("groups a legacy record's turn under `none` rather than inventing one", async () => {
    // Records predating the split carry no engine run id. They must be legible
    // as "not attributable to a turn", not silently folded into another's.
    const dir = makeTmpDir();
    writeRecord(dir, { sessionId: "conv_old" });

    const report = await aggregateUsage(dir, "all", "turn");
    expect((report.breakdowns.turn ?? []).map((r) => r.key)).toEqual(["none"]);
  });
});

// ---------------------------------------------------------------------------
// Breakdown row cap
// ---------------------------------------------------------------------------

describe("the breakdown row cap", () => {
  // `conversation` and `turn` are keyed on ids minted per thread and per turn,
  // so their row count grows with everything the tenant has ever done. The
  // whole report is serialized twice before anything trims it, and the
  // unbounded copy is what lands in the conversation record.

  /** N conversations, each one record, costing more the higher its index. */
  function writeGraduatedConversations(dir: string, n: number): void {
    for (let i = 0; i < n; i++) {
      writeRecord(dir, {
        conversationId: `conv_${String(i).padStart(5, "0")}`,
        usage: { inputTokens: 1000 + i, outputTokens: 500 },
      });
    }
  }

  it("caps the rows and says so", async () => {
    const dir = makeTmpDir();
    writeGraduatedConversations(dir, MAX_BREAKDOWN_ROWS + 40);

    const report = await aggregateUsage(dir, "all", "conversation");
    expect(report.breakdowns.conversation).toHaveLength(MAX_BREAKDOWN_ROWS);
    expect(report.truncatedBreakdowns?.conversation).toEqual({
      returned: MAX_BREAKDOWN_ROWS,
      total: MAX_BREAKDOWN_ROWS + 40,
    });
  });

  it("keeps the costliest rows, not an arbitrary slice", async () => {
    // Cost rises with the index, so the cheapest 40 are the ones dropped. A cap
    // that sliced the key-sorted list would keep exactly the wrong end.
    const dir = makeTmpDir();
    writeGraduatedConversations(dir, MAX_BREAKDOWN_ROWS + 40);

    const keys = (await aggregateUsage(dir, "all", "conversation")).breakdowns.conversation!.map(
      (r) => r.key,
    );
    expect(keys).not.toContain("conv_00000");
    expect(keys).toContain(`conv_${String(MAX_BREAKDOWN_ROWS + 39).padStart(5, "0")}`);
  });

  it("returns capped rows in key order, as an uncapped breakdown does", async () => {
    const dir = makeTmpDir();
    writeGraduatedConversations(dir, MAX_BREAKDOWN_ROWS + 40);

    const keys = (await aggregateUsage(dir, "all", "conversation")).breakdowns.conversation!.map(
      (r) => r.key,
    );
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });

  it("loses no spend — totals still count every record", async () => {
    // The property that makes capping safe: `totals` is accumulated from the
    // records, not from the rows, so a narrower view never understates spend.
    const dir = makeTmpDir();
    const n = MAX_BREAKDOWN_ROWS + 40;
    writeGraduatedConversations(dir, n);

    const report = await aggregateUsage(dir, "all", "conversation");
    expect(report.totals.llmCalls).toBe(n);
    expect(report.totals.conversations).toBe(n);
    const shown = report.breakdowns
      .conversation!.reduce((sum, r) => sum + r.llmCalls, 0);
    expect(shown).toBeLessThan(report.totals.llmCalls);
  });

  it("says nothing when the breakdown is complete", async () => {
    // Absence is the signal, so it must be absent rather than zero-valued.
    const dir = makeTmpDir();
    writeGraduatedConversations(dir, 3);

    const report = await aggregateUsage(dir, "all", "conversation");
    expect(report.truncatedBreakdowns).toBeUndefined();
  });

  it("does not cap `day`, whose zero-fill needs a contiguous series", async () => {
    // Deliberately ABOVE the cap: at 40 days this test passed whether or not
    // the exemption existed, which is no test at all. `day` is bounded by the
    // period rather than by tenant history, and it is filled to a gapless run
    // for the chart it feeds, so a cap would punch holes in it.
    const dir = makeTmpDir();
    const days = MAX_BREAKDOWN_ROWS + 50;
    const start = new Date("2025-01-01T12:00:00Z");
    for (let i = 0; i < days; i++) {
      const ts = new Date(start.getTime() + i * 86_400_000).toISOString();
      writeRecord(dir, { ts, conversationId: `conv_${String(i).padStart(5, "0")}` });
    }

    const report = await aggregateUsage(dir, "all", "day");
    expect(report.breakdowns.day).toHaveLength(days);
    expect(report.truncatedBreakdowns?.day).toBeUndefined();
  });
});
