/** The Runs list: jobs by day, a batch with its bar and counts, a repeated one-off with its count. */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Job } from "../lib/jobs.ts";
import type { TaskBatch } from "../types.ts";
import { RunsBody } from "./RunsView.tsx";

const noop = () => {};
const BATCH: TaskBatch = {
  id: "batch_1",
  taskId: "oneoff-a",
  items: 100,
  concurrency: 8,
  state: "completed",
  counts: {
    pending: 0,
    queued: 0,
    running: 0,
    pass: 85,
    fail: 15,
    uncertain: 0,
    not_assessed: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  },
  costUsd: 4.71,
  createdAt: "2026-10-18T15:40:00.000Z",
  updatedAt: "2026-10-18T15:50:00.000Z",
  done: 100,
  passRate: 0.85,
};

const body = (jobs: Job[]) =>
  renderToStaticMarkup(
    createElement(RunsBody, {
      jobs,
      loading: false,
      error: null,
      onOpenBatch: noop,
      onOpenOneoff: noop,
      onSeeActivity: noop,
    }),
  );

describe("RunsBody", () => {
  test("a batch reads as its name, who asked, its counts, and its cost", () => {
    const html = body([
      {
        kind: "batch",
        key: "batch_1",
        name: "Fit pilot armA",
        via: "Claude Code",
        at: BATCH.updatedAt,
        batch: BATCH,
      },
    ]);
    expect(html).toContain("Fit pilot armA");
    expect(html).toContain("Batch · via Claude Code");
    expect(html).toContain("100 items · 85 passed · 15 failed");
    expect(html).toContain("$4.71");
  });
  test("a repeated one-off shows its count, and how many went badly instead of only the last", () => {
    const html = body([
      {
        kind: "oneoff",
        key: "k",
        name: "Grade fit",
        at: "2026-10-27T09:59:00.000Z",
        runs: 8,
        failed: 1,
        lastStatus: "success",
        taskId: "oneoff-b",
      },
    ]);
    expect(html).toContain("×8");
    expect(html).toContain("7 done · 1 didn&#x27;t work");
    expect(html).toContain("One-off");
  });
  test("a single one-off shows its outcome in plain words", () => {
    const html = body([
      {
        kind: "oneoff",
        key: "k",
        name: "Vendor proposal",
        at: "2026-10-27T09:59:00.000Z",
        runs: 1,
        failed: 1,
        lastStatus: "failure",
        taskId: "oneoff-c",
      },
    ]);
    expect(html).toContain("Didn&#x27;t work");
  });
  test("nothing yet says what will show here, and every run stays a link away", () => {
    const html = body([]);
    expect(html).toContain("Nothing run once yet");
    expect(html).toContain("Every run, scheduled ones included");
  });
});
