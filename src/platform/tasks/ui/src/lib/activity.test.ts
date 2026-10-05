import { describe, expect, test } from "bun:test";
import type { TaskBatch, TaskRun } from "../types.ts";
import { DEFAULT_FILTERS, filterRuns, mergeRows, showsBatches, startedByOf } from "./activity.ts";

function run(id: string, startedAt: string, patch: Partial<TaskRun> = {}): TaskRun {
  return { id, taskId: "t", status: "success", startedAt, label: "Succeeded", ...patch };
}

describe("startedByOf", () => {
  test("a batch item and a retry name their parent before the trigger", () => {
    expect(startedByOf({ batchId: "batch_1", trigger: "manual" })).toBe("batch");
    expect(startedByOf({ retryOf: "run_1", trigger: "manual" })).toBe("retry");
    expect(startedByOf({ trigger: "scheduled" })).toBe("schedule");
    expect(startedByOf({ trigger: "event" })).toBe("event");
    expect(startedByOf({ trigger: "manual" })).toBe("manual");
    expect(startedByOf({})).toBe("not_started");
  });
});

describe("filters", () => {
  const runs = [
    run("a", "2026-10-03T00:00:00Z", { trigger: "scheduled" }),
    run("b", "2026-10-02T00:00:00Z", { trigger: "event", label: "Poor result" }),
  ];
  test("label and started-by are applied client-side", () => {
    expect(filterRuns(runs, { ...DEFAULT_FILTERS, label: "Poor result" }).map((r) => r.id)).toEqual(
      ["b"],
    );
    expect(
      filterRuns(runs, { ...DEFAULT_FILTERS, startedBy: "schedule" }).map((r) => r.id),
    ).toEqual(["a"]);
  });
  test("batches show only when no outcome filter excludes them", () => {
    expect(showsBatches(DEFAULT_FILTERS)).toBe(true);
    expect(showsBatches({ ...DEFAULT_FILTERS, label: "Failed" })).toBe(false);
    expect(showsBatches({ ...DEFAULT_FILTERS, startedBy: "event" })).toBe(false);
  });
});

describe("mergeRows", () => {
  test("interleaves batches by start time, and holds back ones older than the loaded runs", () => {
    const batch = (id: string, createdAt: string) => ({ id, createdAt }) as TaskBatch;
    const rows = mergeRows(
      [run("a", "2026-10-03T00:00:00Z"), run("b", "2026-10-01T00:00:00Z")],
      [batch("new", "2026-10-02T00:00:00Z"), batch("old", "2026-09-01T00:00:00Z")],
      "2026-10-01T00:00:00Z",
    );
    expect(rows.map((r) => (r.kind === "run" ? r.run.id : r.batch.id))).toEqual(["a", "new", "b"]);
  });
});
