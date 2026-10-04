import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { log } from "../../src/observability/log.ts";
import { cancelTask, type TaskWire } from "../../src/tools/mcp-task-client.ts";

/**
 * A wire whose every request answers with `answer`. `TaskWire` attaches only to
 * a connected 2026-07-28 client; `cancelTask` reads nothing but `source` and
 * `request`, so the double carries those two.
 */
function wireAnswering(answer: () => Promise<Record<string, unknown>>): TaskWire {
  return { source: "research", request: answer } as unknown as TaskWire;
}

describe("cancelTask", () => {
  let warn: Mock<typeof log.warn>;

  beforeEach(() => {
    warn = spyOn(log, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it("logs a failed tasks/cancel at warn, naming the source and the task", async () => {
    const wire = wireAnswering(() => Promise.reject(new Error("tasks/cancel timed out")));

    await cancelTask(wire, "task-123");

    expect(warn).toHaveBeenCalledTimes(1);
    const [message, fields] = warn.mock.calls[0] ?? [];
    expect(message).toContain("the remote task may still be running");
    expect(fields).toEqual({
      source: "research",
      taskId: "task-123",
      error: "tasks/cancel timed out",
    });
  });

  it("logs nothing when the server acknowledges", async () => {
    await cancelTask(
      wireAnswering(() => Promise.resolve({})),
      "task-123",
    );

    expect(warn).not.toHaveBeenCalled();
  });
});
