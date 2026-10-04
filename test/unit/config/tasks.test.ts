import { describe, expect, it } from "bun:test";
import {
  describeClampedLimits,
  effectiveRunLimits,
  resolveTasksConfig,
} from "../../../src/config/tasks.ts";

describe("resolveTasksConfig", () => {
  it("fills every key with its default when the block is absent, leaving no input ceiling", () => {
    const resolved = resolveTasksConfig();
    expect(resolved).toEqual({
      maxConcurrentRuns: 2,
      maxQueuedRuns: 50,
      maxRunIterations: 50,
      maxRunInputTokens: undefined,
      maxRunDurationMs: 600_000,
    });
    expect(resolved.maxRunInputTokens).toBeUndefined();
  });

  it("accepts an input ceiling far above the create range, up to its own maximum", () => {
    expect(resolveTasksConfig({ maxRunInputTokens: 20_000_000 }).maxRunInputTokens).toBe(
      20_000_000,
    );
    expect(resolveTasksConfig({ maxRunInputTokens: 5e9 }).maxRunInputTokens).toBe(100_000_000);
    expect(resolveTasksConfig({ maxRunInputTokens: 10 }).maxRunInputTokens).toBe(1_000);
  });

  it("keeps values inside their range and clamps the rest", () => {
    const resolved = resolveTasksConfig({
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
    const resolved = resolveTasksConfig({
      maxConcurrentRuns: "4" as unknown as number,
      maxQueuedRuns: Number.NaN,
    });
    expect(resolved.maxConcurrentRuns).toBe(2);
    expect(resolved.maxQueuedRuns).toBe(50);
  });

  it("allows a zero-length queue", () => {
    expect(resolveTasksConfig({ maxQueuedRuns: 0 }).maxQueuedRuns).toBe(0);
  });
});

describe("effectiveRunLimits", () => {
  const ceilings = resolveTasksConfig({
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

  it("uses the runtime default for unset iterations and duration, and no input cap", () => {
    const limits = effectiveRunLimits({}, resolveTasksConfig(), 25);
    expect(limits).toEqual({ maxIterations: 25, maxRunDurationMs: 120_000 });
    expect("maxInputTokens" in limits).toBe(false);
  });

  it("keeps a definition's own input cap as written when no ceiling is configured", () => {
    expect(effectiveRunLimits({ maxInputTokens: 900_000 }).maxInputTokens).toBe(900_000);
  });

  it("holds an unset input cap to a configured ceiling", () => {
    expect(effectiveRunLimits({}, ceilings).maxInputTokens).toBe(50_000);
  });

  it("describes only the caps it lowered", () => {
    const auto = { maxIterations: 40, maxInputTokens: 2_000 };
    const notes = describeClampedLimits(auto, effectiveRunLimits(auto, ceilings));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("maxIterations 40");
  });
});
