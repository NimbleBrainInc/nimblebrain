import { describe, expect, it } from "bun:test";
import {
  AUTOMATIONS_TASK_SAFE_TOOLS,
  isIdentitySource,
  isTaskForbiddenIdentityTool,
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
  // An unattended automation run must not reach the automation-authoring
  // surface — that is the persistence vector an injected prompt would exploit.
  it("bars every mutating and run-triggering automations tool", () => {
    for (const tool of [
      "automations__create",
      "automations__update",
      "automations__delete",
      "automations__run",
    ]) {
      expect(isTaskForbiddenIdentityTool(tool)).toBe(true);
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

  it("fails closed: a new automations tool is barred unless explicitly marked safe (allowlist)", () => {
    // The defense is an allowlist within the automations namespace, not a
    // denylist of known-bad names — so a future authoring tool is denied by
    // default instead of silently reopening the vector.
    expect(isTaskForbiddenIdentityTool("automations__set_schedule")).toBe(true);
    expect(isTaskForbiddenIdentityTool("automations__pause")).toBe(true);
    expect(isTaskForbiddenIdentityTool("automations__anything_new")).toBe(true);
  });

  it("gates only the automations namespace", () => {
    expect(isTaskForbiddenIdentityTool("nb__search")).toBe(false);
    for (const safe of AUTOMATIONS_TASK_SAFE_TOOLS) {
      expect(safe.startsWith("automations__")).toBe(true);
      expect(isTaskForbiddenIdentityTool(safe)).toBe(false);
    }
  });
});
