import { describe, expect, it } from "bun:test";
import {
  IDENTITY_SOURCES,
  isIdentitySource,
  isTaskForbiddenIdentityTool,
  TASK_FORBIDDEN_IDENTITY_TOOLS,
} from "../../../src/tools/identity-sources.ts";

describe("identity sources", () => {
  it("recognizes the kernel identity sources", () => {
    for (const source of ["conversations", "files", "automations"]) {
      expect(isIdentitySource(source)).toBe(true);
    }
    expect(isIdentitySource("nb")).toBe(false);
    expect(isIdentitySource("some-bundle")).toBe(false);
  });
});

describe("task-forbidden identity tools", () => {
  // An unattended automation run must not be able to author automations —
  // that is the persistence vector an injected prompt would exploit. The
  // mutating + run-triggering tools are barred; read-only introspection is not.
  it("bars every mutating and run-triggering automations tool", () => {
    for (const tool of [
      "automations__create",
      "automations__update",
      "automations__delete",
      "automations__run",
    ]) {
      expect(isTaskForbiddenIdentityTool(tool)).toBe(true);
      expect(TASK_FORBIDDEN_IDENTITY_TOOLS.has(tool)).toBe(true);
    }
  });

  it("leaves read-only automations tools and other identity tools reachable", () => {
    for (const tool of [
      "automations__list",
      "automations__status",
      "automations__runs",
      "automations__run_result",
      "automations__cancel",
      "conversations__search",
      "files__read",
    ]) {
      expect(isTaskForbiddenIdentityTool(tool)).toBe(false);
    }
  });

  it("bars only automations tools (the authoring surface), nothing broader", () => {
    for (const tool of TASK_FORBIDDEN_IDENTITY_TOOLS) {
      expect(tool.startsWith("automations__")).toBe(true);
    }
  });
});
