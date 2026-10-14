import { describe, expect, it } from "bun:test";
import {
  isIdentitySource,
  isTaskForbiddenIdentityTool,
  TASK_RUN_SAFE_TOOLS,
} from "../../../src/tools/identity-sources.ts";

describe("identity sources", () => {
  it("recognizes the kernel identity sources", () => {
    for (const source of ["conversations", "files", "tasks"]) {
      expect(isIdentitySource(source)).toBe(true);
    }
    expect(isIdentitySource("nb")).toBe(false);
    expect(isIdentitySource("some-connector")).toBe(false);
  });
});

describe("task-forbidden identity tools", () => {
  // An unattended task run must not reach the task-authoring
  // surface — that is the persistence vector an injected prompt would exploit.
  it("bars every mutating and run-triggering tasks tool", () => {
    // `tasks__assess` included: a run must not mark its own result passed.
    for (const tool of [
      "tasks__create",
      "tasks__update",
      "tasks__delete",
      "tasks__run",
      "tasks__assess",
    ]) {
      expect(isTaskForbiddenIdentityTool(tool)).toBe(true);
    }
  });

  it("leaves read-only tasks tools and other identity tools reachable", () => {
    for (const tool of [
      "tasks__list",
      "tasks__status",
      "tasks__runs",
      "tasks__run_result",
      "tasks__upcoming",
      "tasks__stats",
      "tasks__judges",
      "tasks__cancel",
      "conversations__search",
      "files__read",
    ]) {
      expect(isTaskForbiddenIdentityTool(tool)).toBe(false);
    }
  });

  it("fails closed: a new tasks tool is barred unless explicitly marked safe (allowlist)", () => {
    // The defense is an allowlist within the tasks namespace, not a
    // denylist of known-bad names — so a future authoring tool is denied by
    // default instead of silently reopening the vector.
    expect(isTaskForbiddenIdentityTool("tasks__set_schedule")).toBe(true);
    expect(isTaskForbiddenIdentityTool("tasks__pause")).toBe(true);
    expect(isTaskForbiddenIdentityTool("tasks__anything_new")).toBe(true);
  });

  it("gates only the tasks namespace", () => {
    expect(isTaskForbiddenIdentityTool("nb__search")).toBe(false);
    for (const safe of TASK_RUN_SAFE_TOOLS) {
      expect(safe.startsWith("tasks__")).toBe(true);
      expect(isTaskForbiddenIdentityTool(safe)).toBe(false);
    }
  });
});
