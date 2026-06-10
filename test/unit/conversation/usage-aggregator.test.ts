import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateUsage, resolveDateRange } from "../../../src/conversation/usage-aggregator.ts";
import { estimateCost } from "../../../src/usage/cost.ts";

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
 * Build a conversation JSONL string.
 *
 * Line 1: metadata (id, updatedAt, totalInputTokens, totalOutputTokens).
 * Lines 2+: event objects (llm.response or anything else).
 */
function buildJsonl(
  meta: {
    id: string;
    updatedAt: string;
    ownerId?: string;
    totalInputTokens?: number;
    totalOutputTokens?: number;
  },
  events: Record<string, unknown>[] = [],
): string {
  const metaLine = JSON.stringify({
    id: meta.id,
    updatedAt: meta.updatedAt,
    ...(meta.ownerId !== undefined ? { ownerId: meta.ownerId } : {}),
    totalInputTokens: meta.totalInputTokens ?? 0,
    totalOutputTokens: meta.totalOutputTokens ?? 0,
  });
  const lines = [metaLine, ...events.map((e) => JSON.stringify(e))];
  return lines.join("\n") + "\n";
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

describe("usage-aggregator", () => {
  it("aggregates tokens from llm.response events even when metadata has zero tokens", async () => {
    const dir = makeTmpDir();
    // Metadata has zero tokens (the old bug: event-sourced store never rewrites line 1)
    const content = buildJsonl(
      { id: "conv-1", updatedAt: "2026-04-10T14:00:00Z", totalInputTokens: 0, totalOutputTokens: 0 },
      [
        llmEvent({ inputTokens: 500, outputTokens: 200 }),
        llmEvent({ inputTokens: 300, outputTokens: 100 }),
      ],
    );
    writeFileSync(join(dir, "conv-1.jsonl"), content);

    const report = await aggregateUsage(dir, "all", "day");

    expect(report.totals.tokens.input).toBe(800);
    expect(report.totals.tokens.output).toBe(300);
    expect(report.totals.llmCalls).toBe(2);
    expect(report.totals.conversations).toBe(1);
  });

  it("filters usage by llm.response timestamp, not conversation updatedAt", async () => {
    const dir = makeTmpDir();

    // Conversation updated inside range, but its only LLM usage happened before
    // the report window. It should not make today's usage non-zero.
    writeFileSync(
      join(dir, "updated-today.jsonl"),
      buildJsonl({ id: "updated-today", updatedAt: "2026-04-12T10:00:00Z" }, [
        llmEvent({ ts: "2026-04-11T23:00:00Z", inputTokens: 9999, outputTokens: 9999 }),
      ]),
    );

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

    writeFileSync(
      join(dir, "updated-later.jsonl"),
      buildJsonl({ id: "updated-later", updatedAt: "2026-05-01T10:00:00Z" }, [
        llmEvent({ ts: "2026-04-10T12:00:00Z", inputTokens: 100, outputTokens: 50 }),
      ]),
    );

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
    writeFileSync(
      join(dir, "cost.jsonl"),
      buildJsonl({ id: "cost-conv", updatedAt: "2026-04-10T10:00:00Z" }, [
        llmEvent({
          model: "claude-sonnet-4-5-20250929",
          inputTokens: 2_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 500_000,
          cacheWriteTokens: 1_000_000,
        }),
      ]),
    );

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

    writeFileSync(
      join(dir, "multi-day.jsonl"),
      buildJsonl({ id: "md", updatedAt: "2026-04-12T10:00:00Z" }, [
        llmEvent({ ts: "2026-04-10T08:00:00Z", inputTokens: 100, outputTokens: 50 }),
        llmEvent({ ts: "2026-04-10T09:00:00Z", inputTokens: 200, outputTokens: 100 }),
        llmEvent({ ts: "2026-04-11T10:00:00Z", inputTokens: 400, outputTokens: 200 }),
      ]),
    );

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
    writeFileSync(
      join(dir, "sparse.jsonl"),
      buildJsonl({ id: "sp", updatedAt: "2026-04-12T10:00:00Z" }, [
        llmEvent({ ts: "2026-04-10T08:00:00Z", inputTokens: 100, outputTokens: 50 }),
        llmEvent({ ts: "2026-04-12T10:00:00Z", inputTokens: 200, outputTokens: 100 }),
      ]),
    );

    const report = await aggregateUsage(dir, "week", "day", { from: "2026-04-10", to: "2026-04-12" });

    expect(report.breakdown).toHaveLength(3);
    expect(report.breakdown[0].key).toBe("2026-04-10");
    expect(report.breakdown[1].key).toBe("2026-04-11");
    expect(report.breakdown[1].llmCalls).toBe(0);
    expect(report.breakdown[2].key).toBe("2026-04-12");
  });

  it("returns multiple breakdown dimensions from one aggregation", async () => {
    const dir = makeTmpDir();
    writeFileSync(
      join(dir, "alice.jsonl"),
      buildJsonl({ id: "alice", updatedAt: "2026-04-12T10:00:00Z", ownerId: "usr_alice" }, [
        llmEvent({ ts: "2026-04-10T08:00:00Z", inputTokens: 100, outputTokens: 50 }),
        llmEvent({ ts: "2026-04-12T10:00:00Z", inputTokens: 200, outputTokens: 100 }),
      ]),
    );
    writeFileSync(
      join(dir, "bob.jsonl"),
      buildJsonl({ id: "bob", updatedAt: "2026-04-11T10:00:00Z", ownerId: "usr_bob" }, [
        llmEvent({ ts: "2026-04-11T10:00:00Z", inputTokens: 400, outputTokens: 200 }),
      ]),
    );

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
    writeFileSync(
      join(dir, "drift.jsonl"),
      buildJsonl({ id: "drift", updatedAt: "2026-04-10T10:00:00Z" }, [
        llmEvent({
          model: "claude-sonnet-4-5-20250929",
          ...usage,
        }),
      ]),
    );
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
    writeFileSync(
      join(dir, "shape.jsonl"),
      buildJsonl({ id: "shape", updatedAt: "2026-04-10T10:00:00Z" }, [
        llmEvent({
          model: "claude-sonnet-4-5-20250929",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 100,
          cacheWriteTokens: 200,
        }),
      ]),
    );
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
    expect(Object.keys(m).sort()).toEqual(["cost", "llmCalls", "model", "tokens"]);
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
    expect(Object.keys(b).sort()).toEqual(["conversations", "cost", "key", "llmCalls", "tokens"]);
  });
});

// ---------------------------------------------------------------------------
// By-user aggregation + owner filter (org/audit surface)
// ---------------------------------------------------------------------------

describe("usage-aggregator — by user", () => {
  /** Two owners, three conversations: alice has two, bob has one. */
  function seedTwoOwners(dir: string): void {
    writeFileSync(
      join(dir, "alice-1.jsonl"),
      buildJsonl({ id: "alice-1", updatedAt: "2026-04-10T10:00:00Z", ownerId: "usr_alice" }, [
        llmEvent({ ts: "2026-04-10T10:00:00Z", inputTokens: 100, outputTokens: 50 }),
      ]),
    );
    writeFileSync(
      join(dir, "alice-2.jsonl"),
      buildJsonl({ id: "alice-2", updatedAt: "2026-04-11T10:00:00Z", ownerId: "usr_alice" }, [
        llmEvent({ ts: "2026-04-11T10:00:00Z", inputTokens: 200, outputTokens: 100 }),
      ]),
    );
    writeFileSync(
      join(dir, "bob-1.jsonl"),
      buildJsonl({ id: "bob-1", updatedAt: "2026-04-10T11:00:00Z", ownerId: "usr_bob" }, [
        llmEvent({ ts: "2026-04-10T11:00:00Z", inputTokens: 400, outputTokens: 200 }),
      ]),
    );
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
    writeFileSync(
      join(dir, "legacy.jsonl"),
      buildJsonl({ id: "legacy", updatedAt: "2026-04-10T10:00:00Z" }, [
        llmEvent({ ts: "2026-04-10T10:00:00Z", inputTokens: 100, outputTokens: 50 }),
      ]),
    );

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
