import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateUsage } from "../../../src/conversation/usage-aggregator.ts";

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
    totalInputTokens?: number;
    totalOutputTokens?: number;
  },
  events: Record<string, unknown>[] = [],
): string {
  const metaLine = JSON.stringify({
    id: meta.id,
    updatedAt: meta.updatedAt,
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
  cacheCreationTokens: number;
  llmMs: number;
}> = {}): Record<string, unknown> {
  return {
    type: "llm.response",
    ts: overrides.ts ?? "2026-04-10T12:00:00Z",
    model: overrides.model ?? "claude-sonnet-4-5-20250929",
    inputTokens: overrides.inputTokens ?? 1000,
    outputTokens: overrides.outputTokens ?? 500,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
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

  it("skips conversations outside date range", async () => {
    const dir = makeTmpDir();

    // Inside range
    writeFileSync(
      join(dir, "in-range.jsonl"),
      buildJsonl({ id: "in", updatedAt: "2026-04-10T10:00:00Z" }, [
        llmEvent({ inputTokens: 100, outputTokens: 50 }),
      ]),
    );

    // Outside range (too old)
    writeFileSync(
      join(dir, "too-old.jsonl"),
      buildJsonl({ id: "old", updatedAt: "2026-03-01T10:00:00Z" }, [
        llmEvent({ inputTokens: 9999, outputTokens: 9999 }),
      ]),
    );

    // Outside range (too new)
    writeFileSync(
      join(dir, "too-new.jsonl"),
      buildJsonl({ id: "new", updatedAt: "2026-05-01T10:00:00Z" }, [
        llmEvent({ inputTokens: 9999, outputTokens: 9999 }),
      ]),
    );

    const report = await aggregateUsage(dir, "month", "day", "2026-04-01", "2026-04-30");

    expect(report.totals.tokens.input).toBe(100);
    expect(report.totals.tokens.output).toBe(50);
    expect(report.totals.llmCalls).toBe(1);
    expect(report.totals.conversations).toBe(1);
  });

  it("computes cost correctly from model catalog", async () => {
    const dir = makeTmpDir();
    // claude-sonnet-4-5-20250929: input=$3/M, output=$15/M, cacheRead=$0.30/M, cacheWrite=$3.75/M
    writeFileSync(
      join(dir, "cost.jsonl"),
      buildJsonl({ id: "cost-conv", updatedAt: "2026-04-10T10:00:00Z" }, [
        llmEvent({
          model: "claude-sonnet-4-5-20250929",
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheCreationTokens: 1_000_000,
        }),
      ]),
    );

    const report = await aggregateUsage(dir, "all", "day");

    const cost = report.totals.cost;
    expect(cost.input).toBeCloseTo(3.0, 4);
    expect(cost.output).toBeCloseTo(15.0, 4);
    expect(cost.cacheRead).toBeCloseTo(0.3, 4);
    expect(cost.cacheCreation).toBeCloseTo(3.75, 4);
    expect(cost.total).toBeCloseTo(3.0 + 15.0 + 0.3 + 3.75, 4);
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
});
