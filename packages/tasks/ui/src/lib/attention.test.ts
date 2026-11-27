/** How the home list reads a task's health: the rules in urgency order, the sort, the headline. */
import { describe, expect, test } from "bun:test";
import type { LiveRun, TaskRun, TaskStats, TaskSummary } from "../types.ts";
import { byUrgency, headline, healthOf, recentFailures } from "./attention.ts";

const TASK: TaskSummary = {
  id: "digest",
  name: "Digest",
  scheduleHuman: "Weekdays at 7:00 AM",
  scheduleType: "cron",
  enabled: true,
  runCount: 3,
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

const run = (id: string, label: TaskRun["label"], day: number, error?: string): TaskRun => ({
  id,
  taskId: "digest",
  execution: label === "Failed" ? "failed" : "completed",
  label,
  startedAt: new Date(Date.UTC(2026, 9, 1 + day)).toISOString(),
  ...(error ? { error } : {}),
});

const running: LiveRun = { taskId: "digest", runId: "run_9", state: "running" };

describe("healthOf, most urgent rule first", () => {
  test("a run in flight wins over everything", () => {
    const h = healthOf(TASK, stats("Failed"), running);
    expect(h).toMatchObject({ word: "Running", tone: "active", runId: "run_9", needsYou: false });
    expect(healthOf(TASK, undefined, { ...running, state: "queued" }).word).toBe(
      "Waiting to start",
    );
  });
  test("a trigger the runtime turned off, before a failure streak", () => {
    const h = healthOf(
      { ...TASK, enabled: false, disabledReason: "Budget reached" },
      stats("Failed"),
    );
    expect(h).toMatchObject({
      word: "Turned off",
      tone: "danger",
      reason: "Budget reached",
      needsYou: true,
    });
  });
  test("a failure streak, before the last run's label, with the newest error and a retry", () => {
    const h = healthOf(TASK, stats("Needs review"), undefined, [
      run("a", "Failed", 1, "The connection expired."),
      run("b", "Failed", 2, "Slack refused the post."),
      run("c", "Failed", 3, "Slack refused the post again."),
    ]);
    expect(h).toMatchObject({
      word: "Failing",
      reason: "Failed 3 times in a row: Slack refused the post again.",
      action: "retry",
      runId: "run_1",
    });
  });
  test("one failure is not a streak: the last run's label speaks", () => {
    expect(healthOf(TASK, stats("Failed")).word).toBe("Didn't work");
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
  test("off is a decision: a failed last run stays quiet, a waiting verdict does not", () => {
    expect(healthOf({ ...TASK, enabled: false }, stats("Failed"))).toMatchObject({
      word: "Paused",
      needsYou: false,
    });
    expect(healthOf({ ...TASK, enabled: false }, stats("Needs review"))).toMatchObject({
      word: "Needs you",
      reason: "Open the last run to see what it needs.",
      action: "review",
      needsYou: true,
    });
  });
  test("a trigger the runtime turned off clears by turning it on and running it", () => {
    expect(healthOf({ ...TASK, enabled: false, disabledReason: "x" }, stats("Failed")).action).toBe(
      "enable-and-retry",
    );
  });
  test("two failures in the last ten, with the last run fine, is flaky", () => {
    const recent = ["Succeeded", "Failed", "Succeeded", "Failed", "Succeeded"].map((l, i) =>
      run(`r${i}`, l as TaskRun["label"], i),
    );
    expect(healthOf(TASK, stats("Succeeded"), undefined, recent)).toMatchObject({
      word: "Flaky",
      tone: "warning",
      reason: "2 of the last 5 runs didn't work.",
      action: "open-task",
    });
    // One failure is noise, not a pattern.
    expect(healthOf(TASK, stats("Succeeded"), undefined, recent.slice(2)).word).toBe("Healthy");
  });
  test("a streak is counted from the runs when the task list carries none", () => {
    const recent = ["Succeeded", "Failed", "Failed", "Failed"].map((l, i) =>
      run(`s${i}`, l as TaskRun["label"], i, "Expired."),
    );
    expect(healthOf(TASK, stats("Failed"), undefined, recent).reason).toBe(
      "Failed 3 times in a row: Expired.",
    );
  });
  test("failures older than the last ten age out", () => {
    const old = [run("o1", "Failed", 0), run("o2", "Failed", 1)];
    const fresh = Array.from({ length: 10 }, (_, i) => run(`f${i}`, "Succeeded", 10 + i));
    expect(recentFailures([...old, ...fresh])).toEqual({ failed: 0, of: 10 });
  });
  test("the quiet states", () => {
    expect(
      healthOf({ ...TASK, onceDone: { at: "x", outcome: "ran" } }, stats("Succeeded")).word,
    ).toBe("Done");
    expect(healthOf({ ...TASK, onceDone: { at: "x", outcome: "missed" } }).word).toBe(
      "Missed its time",
    );
    expect(healthOf({ ...TASK, scheduleType: "none" }).word).toBe("No runs yet");
    expect(healthOf(TASK, stats("Succeeded"))).toMatchObject({ word: "Healthy", tone: "success" });
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
    expect(headline(0, 0)).toBe("Nothing scheduled yet");
    expect(headline(0, 4)).toBe("Everything is on track");
    expect(headline(1, 4)).toBe("1 needs you");
    expect(headline(3, 4)).toBe("3 need you");
  });
});
