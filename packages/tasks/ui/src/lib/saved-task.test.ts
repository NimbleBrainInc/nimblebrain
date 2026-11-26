import { describe, expect, test } from "bun:test";
import type { TaskSummary } from "../types.ts";
import { savedTaskOf, withSavedTask } from "./saved-task.ts";

const row = (id: string, enabled: boolean): TaskSummary => ({
  id,
  name: id,
  scheduleHuman: "Every day at 9:00 AM",
  enabled,
  runCount: 3,
  lastRunAt: "2026-11-01T09:00:00.000Z",
  ...(enabled ? { nextRunAt: "2026-11-02T09:00:00.000Z" } : {}),
});

describe("a saved task's row", () => {
  test("turning one off changes only its row", () => {
    const tasks = [row("a", true), row("b", true)];
    const next = withSavedTask(tasks, {
      id: "a",
      enabled: false,
      disabledAt: "2026-11-01T10:00:00.000Z",
    });
    expect(next[0]).toMatchObject({
      enabled: false,
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
    });
    expect(next).toMatchObject({
      enabled: true,
      nextRunAt: "2026-11-02T09:00:00.000Z",
    });
  });
  test("an answer without a task is not read as one", () => {
    expect(savedTaskOf(undefined)).toBeNull();
    expect(savedTaskOf({ updated: true })).toBeNull();
    expect(savedTaskOf({ task: { id: "a", enabled: true } })).toEqual({ id: "a", enabled: true });
  });
});
