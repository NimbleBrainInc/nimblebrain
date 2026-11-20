import { describe, expect, test } from "bun:test";
import type { TaskSummary } from "../types.ts";
import { savedTaskOf, withSavedTask } from "./saved-task.ts";

const row = (id: string, enabled: boolean): TaskSummary => ({
  id,
  name: id,
  schedule: "Every day at 9:00 AM",
  enabled,
  source: "user",
  runCount: 3,
  lastRunStatus: "success",
  lastRunAt: "2026-11-01T09:00:00.000Z",
  nextRunAt: enabled ? "2026-11-02T09:00:00.000Z" : null,
});

describe("a saved task's row", () => {
  test("turning one off changes only its row", () => {
    const tasks = [row("a", true), row("b", true)];
    const next = withSavedTask(tasks, {
      id: "a",
      enabled: false,
      consecutiveErrors: 0,
      disabledAt: "2026-11-01T10:00:00.000Z",
    });
    expect(next[0]).toMatchObject({
      enabled: false,
      nextRunAt: null,
      disabledAt: "2026-11-01T10:00:00.000Z",
    });
    expect(next[0]?.runCount).toBe(3);
    expect(next[1]).toBe(tasks[1]);
  });
  test("turning one on takes its next fire and clears why it was off", () => {
    const off = { ...row("a", false), disabledAt: "x", disabledReason: "Turned off" };
    const [next] = withSavedTask([off], {
      id: "a",
      enabled: true,
      nextRunAt: "2026-11-02T09:00:00.000Z",
      consecutiveErrors: 0,
    });
    expect(next).toMatchObject({
      enabled: true,
      nextRunAt: "2026-11-02T09:00:00.000Z",
      disabledAt: null,
      disabledReason: null,
    });
  });
  test("an answer without a task is not read as one", () => {
    expect(savedTaskOf(undefined)).toBeNull();
    expect(savedTaskOf({ updated: true })).toBeNull();
    expect(savedTaskOf({ task: { id: "a", enabled: true } })).toEqual({ id: "a", enabled: true });
  });
});
