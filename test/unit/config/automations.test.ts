import { describe, expect, it } from "bun:test";
import {
  describeClampedLimits,
  effectiveRunLimits,
  resolveAutomationsConfig,
} from "../../../src/config/automations.ts";

describe("resolveAutomationsConfig", () => {
  it("fills every key with its default when the block is absent", () => {
    expect(resolveAutomationsConfig()).toEqual({
      maxConcurrentRuns: 2,
      maxQueuedRuns: 50,
      maxRunIterations: 50,
      maxRunInputTokens: 1_000_000,
      maxRunDurationMs: 600_000,
    });
  });

  it("keeps values inside their range and clamps the rest", () => {
    const resolved = resolveAutomationsConfig({
      maxConcurrentRuns: 0,
      maxQueuedRuns: 5000,
      maxRunIterations: 80,
      maxRunInputTokens: 200_000,
      maxRunDurationMs: 1,
    });
    expect(resolved).toEqual({
      maxConcurrentRuns: 1,
      maxQueuedRuns: 1000,
      maxRunIterations: 50,
      maxRunInputTokens: 200_000,
      maxRunDurationMs: 10_000,
    });
  });

  it("falls back to the default for a value that is not a number", () => {
    const resolved = resolveAutomationsConfig({
      maxConcurrentRuns: "4" as unknown as number,
      maxQueuedRuns: Number.NaN,
    });
    expect(resolved.maxConcurrentRuns).toBe(2);
    expect(resolved.maxQueuedRuns).toBe(50);
  });

  it("allows a zero-length queue", () => {
    expect(resolveAutomationsConfig({ maxQueuedRuns: 0 }).maxQueuedRuns).toBe(0);
  });
});

describe("effectiveRunLimits", () => {
  const ceilings = resolveAutomationsConfig({
    maxRunIterations: 10,
    maxRunInputTokens: 50_000,
    maxRunDurationMs: 60_000,
  });

  it("lowers a cap above its ceiling", () => {
    expect(
      effectiveRunLimits(
        { maxIterations: 40, maxInputTokens: 900_000, maxRunDurationMs: 300_000 },
        ceilings,
      ),
    ).toEqual({ maxIterations: 10, maxInputTokens: 50_000, maxRunDurationMs: 60_000 });
  });

  it("uses the runtime default for unset iterations and duration, and the ceiling for tokens", () => {
    expect(effectiveRunLimits({}, resolveAutomationsConfig(), 25)).toEqual({
      maxIterations: 25,
      maxInputTokens: 1_000_000,
      maxRunDurationMs: 120_000,
    });
  });

  it("describes only the caps it lowered", () => {
    const auto = { maxIterations: 40, maxInputTokens: 2_000 };
    const notes = describeClampedLimits(auto, effectiveRunLimits(auto, ceilings));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("maxIterations 40");
  });
});
