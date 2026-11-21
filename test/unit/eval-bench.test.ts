import { describe, expect, test } from "bun:test";
import type { Task, TaskRun } from "../../src/platform/tasks/types.ts";
import type { ChatResult } from "../../src/runtime/types.ts";
import { CASES, type RunState } from "../eval/bench/cases.ts";
import { fromTurns } from "../eval/bench/run.ts";

function turn(response: string, calls: Array<{ name: string; ok?: boolean }> = []): ChatResult {
  return {
    response,
    conversationId: "c1",
    skillName: null,
    toolCalls: calls.map((c, i) => ({
      id: `t${i}`,
      name: c.name,
      input: {},
      output: "ok",
      ok: c.ok ?? true,
      ms: 1,
    })),
    stopReason: "complete",
    usage: { inputTokens: 100, outputTokens: 20, model: "m", llmMs: 1, iterations: 2 },
    costUsd: 0.03,
  };
}

const check = (id: string, state: RunState) => {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c.check(state);
};

describe("bench goal checks", () => {
  const task = { id: "t1", schedule: { type: "cron", expression: "0 9 * * 1-5" } } as Task;
  const run = (status: TaskRun["status"]) => ({ id: "r1", status }) as TaskRun;

  test("a refused task run is not an execution", () => {
    const errs = check("task-lifecycle", {
      turns: [],
      files: [],
      tasks: [{ task, runs: [run("skipped")] }],
    });
    expect(errs).toEqual(["no run completed (skipped)"]);
  });

  test("a completed task run meets the goal", () => {
    expect(
      check("task-lifecycle", { turns: [], files: [], tasks: [{ task, runs: [run("success")] }] }),
    ).toEqual([]);
  });

  test("the saved note must hold the venue, not just the reply", () => {
    const errs = check("file-roundtrip", {
      turns: [turn("Saved."), turn("It said Pier 9.")],
      files: [{ filename: "launch.txt", text: "4417" }],
      tasks: [],
    });
    expect(errs).toEqual(["launch.txt lacks the venue"]);
  });
});

describe("bench run record", () => {
  test("completed turns keep their cost and trace when a later turn throws", () => {
    // The error path records whatever turns finished before the throw.
    const r = fromTurns([turn("Done.", [{ name: "files__create" }])]);
    expect(r.inputTokens).toBe(100);
    expect(r.costUsd).toBe(0.03);
    expect(r.trace.map((t) => t.name)).toEqual(["files__create"]);
    expect(r.replies).toEqual(["Done."]);
  });
});
