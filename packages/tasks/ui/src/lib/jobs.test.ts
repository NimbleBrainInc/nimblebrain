/** How work run once reads in the Runs list: names in words, batches whole, one row per one-off. */
import { describe, expect, test } from "bun:test";
import type { TaskBatch, TaskSummary } from "../types.ts";
import { batchName, jobsOf, oneoffName, wordsFromKey, wordsFromPrompt } from "./jobs.ts";

const oneoff = (id: string, over: Partial<TaskSummary> = {}): TaskSummary => ({
  id,
  name: id,
  scheduleHuman: "Manual only",
  scheduleType: "none",
  kind: "oneoff",
  enabled: true,
  runCount: 1,
  lastRunLabel: "Succeeded",
  lastRunAt: "2026-10-27T09:59:00.000Z",
  ...over,
});

const counts = {
  pending: 0,
  queued: 0,
  running: 0,
  pass: 85,
  fail: 15,
  not_assessed: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
};
const batch = (id: string, over: Partial<TaskBatch> = {}): TaskBatch => ({
  id,
  taskId: "oneoff-armA",
  items: 100,
  concurrency: 8,
  state: "completed",
  counts,
  costUsd: 4.71,
  createdAt: "2026-10-18T15:40:00.000Z",
  updatedAt: "2026-10-18T15:50:00.000Z",
  completedAt: "2026-10-18T15:50:49.000Z",
  done: 100,
  passRate: 0.85,
  ...over,
});

describe("names", () => {
  test("a key reads as words, without its date", () => {
    expect(wordsFromKey("fit-pilot-2026-10-18-armA-default")).toBe("Fit pilot armA default");
    expect(wordsFromKey("cap-test-C-2000")).toBe("Cap test C 2000");
  });
  test("a prompt's first words, with an ellipsis when it goes on", () => {
    expect(wordsFromPrompt("Grade fit.")).toBe("Grade fit");
    expect(wordsFromPrompt("Research the account and draft a first touch for its buyer")).toBe(
      "Research the account and draft a first…",
    );
  });
  test("a one-off's own name wins; a generated id falls back to its prompt", () => {
    expect(oneoffName(oneoff("oneoff-1", { name: "Fit grade, arm A" }))).toBe("Fit grade, arm A");
    expect(oneoffName(oneoff("oneoff-1", { promptPreview: "Grade fit for one account" }))).toBe(
      "Grade fit for one account",
    );
    expect(oneoffName(oneoff("oneoff-1"))).toBe("One-off run");
  });
  test("a batch: its name, its saved task's, its key's words, then its one-off's", () => {
    const tasks = new Map([
      ["saved-grade", { ...oneoff("saved-grade"), name: "Fit grade", kind: "saved" as const }],
    ]);
    expect(batchName(batch("b1", { name: "Pilot A" }), tasks)).toBe("Pilot A");
    expect(batchName(batch("b1", { taskId: "saved-grade" }), tasks)).toBe("Fit grade");
    expect(batchName(batch("b1", { idempotencyKey: "fit-pilot-armA" }), tasks)).toBe(
      "Fit pilot armA",
    );
    expect(batchName(batch("b1"), new Map())).toBe("Batch");
  });
});

describe("jobsOf", () => {
  test("a batch is one row, and the one-off it runs is not a row of its own", () => {
    const jobs = jobsOf([oneoff("oneoff-armA", { runCount: 100 })], [batch("b1")], []);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ kind: "batch", key: "b1" });
  });
  test("each one-off is its own row, newest first, opening only itself", () => {
    const prefix = "x".repeat(140);
    const jobs = jobsOf(
      [
        oneoff("oneoff-a", {
          promptPreview: prefix,
          lastRunLabel: "Failed",
          lastRunAt: "2026-10-27T09:58:00.000Z",
        }),
        oneoff("oneoff-b", {
          promptPreview: prefix,
          lastRunAt: "2026-10-27T09:59:30.000Z",
        }),
      ],
      [],
      [],
    );
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      kind: "oneoff",
      runs: 1,
      lastLabel: "Succeeded",
      taskId: "oneoff-b",
    });
    expect(jobs[1]).toMatchObject({ lastLabel: "Failed", taskId: "oneoff-a" });
  });
  test("a one-off that never ran is not listed", () => {
    expect(jobsOf([oneoff("oneoff-x", { lastRunAt: undefined })], [], [])).toHaveLength(0);
  });
});
