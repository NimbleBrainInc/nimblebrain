/**
 * The breadcrumb the panel sends the host maps one to one to its page stack,
 * and picking a crumb pops back to that page.
 */
import { describe, expect, test } from "bun:test";
import { runName } from "../lib/plain.ts";
import type { TaskRun } from "../types.ts";
import { type Screen, TRAIL_ROOT_ID, trailFor, withRun } from "./trail.ts";

const labels = (stack: Screen[]) => trailFor(stack).map((s) => s.label);
const TASK: Screen = { kind: "task", taskId: "digest", taskName: "Digest" };
const DIGEST = { id: "digest", name: "Digest" };

describe("trailFor", () => {
  test("the home list is the root alone", () => {
    expect(labels([])).toEqual(["Tasks"]);
    expect(trailFor([])[0]?.id).toBe(TRAIL_ROOT_ID);
  });

  test("one crumb per page", () => {
    expect(labels([TASK])).toEqual(["Tasks", "Digest"]);
    expect(labels([{ kind: "upcoming" }])).toEqual(["Tasks", "Coming up"]);
    expect(labels([{ kind: "activity" }])).toEqual(["Tasks", "Every run"]);
    expect(labels([TASK, { kind: "activity", taskId: "digest", taskName: "Digest" }])).toEqual([
      "Tasks",
      "Digest",
      "All runs",
    ]);
    expect(labels([TASK, { kind: "result", runId: "run_abcdef123456", taskId: "digest" }])).toEqual(
      ["Tasks", "Digest", "Run"],
    );
    expect(labels([TASK, { kind: "editor", taskId: "digest" }])).toEqual([
      "Tasks",
      "Digest",
      "Edit",
    ]);
    expect(labels([{ kind: "editor" }])).toEqual(["Tasks", "New task"]);
  });

  test("each crumb leads to the stack up to its page: the task crumb to the task page", () => {
    const stack: Screen[] = [TASK, { kind: "result", runId: "run_1", taskId: "digest" }];
    const trail = trailFor(stack);
    expect(trail[0]?.stack).toEqual([]);
    expect(trail[1]?.stack).toEqual([TASK]);
    expect(trail[2]?.stack).toEqual(stack);
  });

  test("the same page twice is two crumbs with their own ids", () => {
    const ids = trailFor([TASK, { kind: "activity" }, TASK]).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("withRun", () => {
  const run = (runId: string): Extract<Screen, { kind: "result" }> => ({
    kind: "result",
    runId,
    taskId: "digest",
  });

  test("from the home list, the run opens under its task's page", () => {
    expect(withRun([], run("r1"), DIGEST)).toEqual([TASK, run("r1")]);
  });
  test("from the task's page, the run goes on top", () => {
    expect(withRun([TASK], run("r1"), DIGEST)).toEqual([TASK, run("r1")]);
  });
  test("from the task's runs, the task is not added again", () => {
    const runs: Screen = { kind: "activity", taskId: "digest", taskName: "Digest" };
    expect(withRun([TASK, runs], run("r1"), DIGEST)).toEqual([TASK, runs, run("r1")]);
  });
  test("from every run, the task's page comes between", () => {
    expect(withRun([{ kind: "activity" }], run("r1"), DIGEST)).toEqual([
      { kind: "activity" },
      TASK,
      run("r1"),
    ]);
  });
  test("a run on top gives way to the next one (a re-run, a retried run)", () => {
    expect(withRun([TASK, run("r1")], run("r2"), DIGEST)).toEqual([TASK, run("r2")]);
  });
  test("a run of a task the list does not know opens alone", () => {
    expect(withRun([], run("r1"), undefined)).toEqual([run("r1")]);
  });
});

describe("a run's name", () => {
  test("the crumb and the page heading use the same name, never the run id", () => {
    const run = {
      id: "run_470d01aa",
      taskId: "digest",
      status: "success",
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    } as TaskRun;
    const crumb = trailFor([TASK, { kind: "result", runId: run.id, taskId: "digest", run }])[2]
      ?.label;
    expect(crumb).toBe(runName(run.startedAt));
    expect(crumb).toMatch(/^Run Yesterday /);
    expect(crumb).not.toContain("470d01");
  });
});
