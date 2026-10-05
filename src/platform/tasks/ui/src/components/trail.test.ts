/** The breadcrumb the panel sends the host, and where each step leads back to. */
import { describe, expect, test } from "bun:test";
import { type Screen, TRAIL_ROOT_ID, trailFor } from "./trail.ts";

const nameOf = (id: string) => ({ digest: "Digest" })[id];
const labels = (view: Parameters<typeof trailFor>[0], stack: Screen[]) =>
  trailFor(view, stack, nameOf).map((s) => s.label);

describe("trailFor", () => {
  test("a view: Tasks › the view", () => {
    expect(labels("upcoming", [])).toEqual(["Tasks", "Upcoming"]);
    expect(trailFor("saved", [], nameOf)[0]?.id).toBe(TRAIL_ROOT_ID);
  });

  test("a task page: Tasks › Saved › task", () => {
    expect(labels("activity", [{ kind: "task", taskName: "Digest" }])).toEqual([
      "Tasks",
      "Saved",
      "Digest",
    ]);
  });

  test("a run opened from Activity names its task as the parent", () => {
    const trail = trailFor(
      "activity",
      [{ kind: "result", runId: "run_abcdef123456", taskId: "digest" }],
      nameOf,
    );
    expect(trail.map((s) => s.label)).toEqual(["Tasks", "Digest", "Run abcdef"]);
    expect(trail[1]?.stack).toEqual([{ kind: "task", taskName: "Digest" }]);
  });

  test("a run opened from its task page does not repeat the task", () => {
    expect(
      labels("saved", [
        { kind: "task", taskName: "Digest" },
        { kind: "result", runId: "run_abcdef123456", taskId: "digest" },
      ]),
    ).toEqual(["Tasks", "Saved", "Digest", "Run abcdef"]);
  });

  test("the editor: task › Edit, or New task", () => {
    expect(labels("saved", [{ kind: "editor", taskName: "Digest" }])).toEqual([
      "Tasks",
      "Digest",
      "Edit",
    ]);
    expect(labels("saved", [{ kind: "editor" }])).toEqual(["Tasks", "New task"]);
    expect(labels("saved", [{ kind: "editor", copyOf: "Digest" }])).toEqual(["Tasks", "New task"]);
  });

  test("each step leads back to the stack under it", () => {
    const stack: Screen[] = [
      { kind: "task", taskName: "Digest" },
      { kind: "result", runId: "run_1", taskId: "digest" },
    ];
    const trail = trailFor("saved", stack, nameOf);
    expect(trail[0]?.stack).toEqual([]);
    expect(trail[1]).toMatchObject({ stack: [], view: "saved" });
    expect(trail[2]?.stack).toEqual([stack[0]]);
    expect(trail[3]?.stack).toEqual(stack);
  });
});
