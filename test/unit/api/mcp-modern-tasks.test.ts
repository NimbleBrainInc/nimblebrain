import { describe, expect, it } from "bun:test";
import {
  doorTaskId,
  modernCreateTaskResult,
  optsInToTasks,
  parseDoorTaskId,
  TASKS_EXTENSION_ID,
} from "../../../src/api/mcp-modern-tasks.ts";

describe("the door's 2026 task id", () => {
  it("names the source beside the connector's own id", () => {
    const id = doorTaskId("research", "task:1/2");
    expect(parseDoorTaskId(id)).toEqual({ source: "research", taskId: "task:1/2" });
  });

  it("keeps two sources' equal task ids apart", () => {
    expect(doorTaskId("a", "t1")).not.toBe(doorTaskId("b", "t1"));
  });

  it.each([
    "",
    "not-base64-json",
    Buffer.from("[1,2]").toString("base64url"),
    Buffer.from('["only-one"]').toString("base64url"),
  ])("reads %p as no task", (id) => {
    expect(parseDoorTaskId(id)).toBeNull();
  });
});

describe("optsInToTasks", () => {
  it("is true only when the request's client capabilities name the extension", () => {
    expect(optsInToTasks({ extensions: { [TASKS_EXTENSION_ID]: {} } })).toBe(true);
    expect(optsInToTasks({ extensions: {} })).toBe(false);
    expect(optsInToTasks({})).toBe(false);
    expect(optsInToTasks(undefined)).toBe(false);
  });
});

describe("modernCreateTaskResult", () => {
  it("renames the 2025 task's fields to the 2026 wire's, under the door's id", () => {
    const now = new Date().toISOString();
    expect(
      modernCreateTaskResult("research", {
        taskId: "t1",
        status: "working",
        createdAt: now,
        lastUpdatedAt: now,
        ttl: 1000,
        pollInterval: 50,
      }),
    ).toEqual({
      resultType: "task",
      taskId: doorTaskId("research", "t1"),
      status: "working",
      createdAt: now,
      lastUpdatedAt: now,
      ttlMs: 1000,
      pollIntervalMs: 50,
    });
  });
});
