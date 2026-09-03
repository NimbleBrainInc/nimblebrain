/**
 * The poll's pacing: the defaults, the clamps, and the two rules that keep a
 * mistyped config from producing a loop nobody intended — a hot one, or one
 * where an idle source is read faster than a busy one.
 */

import { describe, expect, test } from "bun:test";
import {
  backoffIntervalMs,
  clampNextPollMs,
  DEFAULT_BUDGET_PER_MINUTE,
  POLL_FLOOR_MS,
  resolvePollConfig,
} from "../../../src/notifications/poll-config.ts";

describe("resolvePollConfig", () => {
  test("resolves the documented defaults", () => {
    expect(resolvePollConfig()).toEqual({
      intervalMs: 60_000,
      maxIntervalMs: 300_000,
      maxEvents: 100,
      budgetPerMinute: DEFAULT_BUDGET_PER_MINUTE,
    });
  });

  test("the derived budget is a quarter of the edge's rate at three requests a poll", () => {
    expect(DEFAULT_BUDGET_PER_MINUTE).toBe(10);
  });

  test("floors the interval at the poll floor", () => {
    expect(resolvePollConfig({ intervalMs: 1 }).intervalMs).toBe(POLL_FLOOR_MS);
  });

  test("never resolves a ceiling below the base", () => {
    // Otherwise an idle source would back off to a FASTER cadence than a busy
    // one, which is the opposite of what the knob says it does.
    const resolved = resolvePollConfig({ intervalMs: 120_000, maxIntervalMs: 30_000 });
    expect(resolved.maxIntervalMs).toBe(120_000);
  });

  test("falls back to the default for a value that is not a positive number", () => {
    const resolved = resolvePollConfig({
      intervalMs: Number.NaN,
      maxEvents: -5,
      budgetPerMinute: 0,
    });
    expect(resolved.intervalMs).toBe(60_000);
    expect(resolved.maxEvents).toBe(100);
    expect(resolved.budgetPerMinute).toBe(DEFAULT_BUDGET_PER_MINUTE);
  });

  test("caps maxEvents so one answer cannot be unbounded", () => {
    expect(resolvePollConfig({ maxEvents: 100_000 }).maxEvents).toBe(1000);
  });
});

describe("clampNextPollMs", () => {
  const config = resolvePollConfig();

  test("honours a recommendation inside the range", () => {
    expect(clampNextPollMs(90_000, config)).toBe(90_000);
  });

  test("clamps rather than discards at either end", () => {
    // A server asking for 2s is saying "as fast as you will go", and one asking
    // for a day is saying "as slow as you will go". Both meanings survive.
    expect(clampNextPollMs(2_000, config)).toBe(POLL_FLOOR_MS);
    expect(clampNextPollMs(86_400_000, config)).toBe(config.maxIntervalMs);
  });
});

describe("backoffIntervalMs", () => {
  const config = resolvePollConfig();

  test("doubles per empty poll and stops at the ceiling", () => {
    expect(backoffIntervalMs(0, config)).toBe(60_000);
    expect(backoffIntervalMs(1, config)).toBe(120_000);
    expect(backoffIntervalMs(2, config)).toBe(240_000);
    expect(backoffIntervalMs(3, config)).toBe(300_000);
  });

  test("a long streak stays finite", () => {
    expect(backoffIntervalMs(10_000, config)).toBe(config.maxIntervalMs);
  });
});
