/** How the home list reads a task's health: the rules in urgency order, the sort, the headline. */
import { describe, expect, test } from "bun:test";
import type { TaskStats, TaskSummary, UpcomingRun } from "../types.ts";
import { byUrgency, headline, healthOf } from "./attention.ts";

const TASK: TaskSummary = {
  id: "digest",
  name: "Digest",
  schedule: "Weekdays at 7:00 AM",
  scheduleType: "cron",
  enabled: true,
  source: "user",
  runCount: 3,
  lastRunStatus: "success",
  lastRunAt: null,
  nextRunAt: null,
};

const stats = (label: NonNullable<TaskStats["lastRun"]>["label"]): TaskStats => ({
  taskId: "digest",
  runs: 3,
  pass: 2,
  fail: 1,
  uncertain: 0,
  passRate: 0.67,
  costUsd: 1,
  lastRun: { id: "run_1", startedAt: "2026-10-04T00:00:00Z", label },
});

const running: UpcomingRun = { taskId: "digest", runId: "run_9", state: "running" };

describe("healthOf, most urgent rule first", () => {
  test("a run in flight wins over everything", () => {
    const h = healthOf({ ...TASK, consecutiveErrors: 5 }, stats("Failed"), running);
    expect(h).toMatchObject({ word: "Running", tone: "active", runId: "run_9", needsYou: false });
    expect(healthOf(TASK, undefined, { ...running, state: "queued" }).word).toBe(
      "Waiting to start",
    );
  });
  test("a trigger the runtime turned off, before a failure streak", () => {
    const h = healthOf(
      { ...TASK, enabled: false, disabledReason: "Budget reached", consecutiveErrors: 3 },
      stats("Failed"),
    );
    expect(h).toMatchObject({
      word: "Turned off",
      tone: "danger",
      reason: "Budget reached",
      needsYou: true,
    });
  });
  test("a failure streak, before the last run's label", () => {
    const h = healthOf({ ...TASK, consecutiveErrors: 3 }, stats("Needs review"));
    expect(h).toMatchObject({ word: "Failing", reason: "The last 3 runs failed.", runId: "run_1" });
  });
  test("one failure is not a streak: the last run's label speaks", () => {
    expect(healthOf({ ...TASK, consecutiveErrors: 1 }, stats("Failed")).word).toBe("Failed");
    expect(healthOf(TASK, stats("Poor result"))).toMatchObject({ tone: "danger", needsYou: true });
    expect(healthOf(TASK, stats("Needs review"))).toMatchObject({
      tone: "warning",
      needsYou: true,
    });
  });
  test("a trigger the owner turned off is Paused, not urgent", () => {
    expect(healthOf({ ...TASK, enabled: false }, stats("Succeeded"))).toMatchObject({
      word: "Paused",
      paused: true,
      needsYou: false,
    });
  });
  test("a bad last run still needs you when paused", () => {
    expect(healthOf({ ...TASK, enabled: false }, stats("Failed")).needsYou).toBe(true);
  });
  test("the quiet states", () => {
    expect(
      healthOf({ ...TASK, onceDone: { at: "x", outcome: "ran" } }, stats("Succeeded")).word,
    ).toBe("Done");
    expect(healthOf({ ...TASK, onceDone: { at: "x", outcome: "missed" } }).word).toBe(
      "Missed its time",
    );
    expect(healthOf({ ...TASK, scheduleType: "none" }).word).toBe("No runs yet");
    expect(healthOf(TASK, stats("Succeeded"))).toMatchObject({ word: "On track", tone: "success" });
  });
});

describe("byUrgency", () => {
  test("danger, then warning, active, success, muted; ties by name", () => {
    const row = (name: string, tone: "danger" | "warning" | "active" | "success" | "muted") => ({
      name,
      health: { word: "", tone, needsYou: false, paused: false },
    });
    const sorted = byUrgency([
      row("b", "success"),
      row("z", "danger"),
      row("m", "muted"),
      row("a", "danger"),
      row("w", "warning"),
      row("r", "active"),
    ]);
    expect(sorted.map((r) => r.name)).toEqual(["a", "z", "w", "r", "b", "m"]);
  });
});

describe("headline", () => {
  test("says how many need you", () => {
    expect(headline(0, 0)).toBe("No tasks yet");
    expect(headline(0, 4)).toBe("Everything is on track");
    expect(headline(1, 4)).toBe("1 task needs you");
    expect(headline(3, 4)).toBe("3 tasks need you");
  });
});
