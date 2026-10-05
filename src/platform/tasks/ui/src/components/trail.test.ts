/** The breadcrumb the panel sends the host, and where each step leads back to. */
import { describe, expect, test } from "bun:test";
import { type Screen, TRAIL_ROOT_ID, trailFor } from "./trail.ts";

const nameOf = (id: string) => ({ digest: "Digest" })[id];
const labels = (stack: Screen[]) => trailFor(stack, nameOf).map((s) => s.label);

describe("trailFor", () => {
  test("the home list is the root alone", () => {
    expect(labels([])).toEqual(["Tasks"]);
    expect(trailFor([], nameOf)[0]?.id).toBe(TRAIL_ROOT_ID);
  });

  test("a task: Tasks › task", () => {
    expect(labels([{ kind: "task", taskName: "Digest" }])).toEqual(["Tasks", "Digest"]);
  });

  test("what's coming up and every run", () => {
    expect(labels([{ kind: "upcoming" }])).toEqual(["Tasks", "Coming up"]);
    expect(labels([{ kind: "activity" }])).toEqual(["Tasks", "Every run"]);
  });

  test("a task's runs name the task, once", () => {
    expect(
      labels([
        { kind: "task", taskName: "Digest" },
        { kind: "activity", taskId: "digest", taskName: "Digest" },
      ]),
    ).toEqual(["Tasks", "Digest", "Runs"]);
  });

  test("a run opened from the list names its task as the parent", () => {
    const trail = trailFor(
      [{ kind: "result", runId: "run_abcdef123456", taskId: "digest" }],
      nameOf,
    );
    expect(trail.map((s) => s.label)).toEqual(["Tasks", "Digest", "Run abcdef"]);
    expect(trail[1]?.stack).toEqual([{ kind: "task", taskName: "Digest" }]);
  });

  test("a run opened from its task does not repeat the task", () => {
    expect(
      labels([
        { kind: "task", taskName: "Digest" },
        { kind: "result", runId: "run_abcdef123456", taskId: "digest" },
      ]),
    ).toEqual(["Tasks", "Digest", "Run abcdef"]);
  });

  test("the editor: task › Edit, or New task", () => {
    expect(labels([{ kind: "editor", taskName: "Digest" }])).toEqual(["Tasks", "Digest", "Edit"]);
    expect(labels([{ kind: "editor" }])).toEqual(["Tasks", "New task"]);
    expect(labels([{ kind: "editor", copyOf: "Digest" }])).toEqual(["Tasks", "New task"]);
  });

  test("each step leads back to the stack under it", () => {
    const stack: Screen[] = [
      { kind: "task", taskName: "Digest" },
      { kind: "result", runId: "run_1", taskId: "digest" },
    ];
    const trail = trailFor(stack, nameOf);
    expect(trail[0]?.stack).toEqual([]);
    expect(trail[1]?.stack).toEqual([stack[0]]);
    expect(trail[2]?.stack).toEqual(stack);
  });
});
