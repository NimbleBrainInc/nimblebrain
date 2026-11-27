/**
 * The tasks plugin's authoring guide teaches the model the shape of a
 * `tasks__create` call, and the plugin serves the same text as its server
 * instructions. Every JSON example in it must be a call the contract accepts:
 * a guide that shows a refused shape (a cron with no timezone) makes a model
 * that follows it fail with `invalid_input`.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

const ROOT = join(import.meta.dir, "../../..");
const SKILL = readFileSync(join(ROOT, "packages/tasks/skills/task-authoring/SKILL.md"), "utf-8");
const CONTRACT = JSON.parse(
  readFileSync(join(ROOT, "schemas/contracts/tasks/v1/contract.json"), "utf-8"),
) as { $id: string; $defs: Record<string, { properties?: Record<string, unknown> }> };

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(CONTRACT);
const validateCreate = ajv.getSchema(`${CONTRACT.$id}#/$defs/create_input`);
const validateSchedule = ajv.getSchema(
  `${CONTRACT.$id}#/$defs/create_input/properties/manifest/properties/schedule`,
);

/** Every inline-code span in the guide that parses as a JSON object. */
function jsonExamples(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const [, code] of text.matchAll(/`([^`]+)`/g)) {
    if (!code?.trim().startsWith("{")) continue;
    try {
      const value = JSON.parse(code) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        found.push(value as Record<string, unknown>);
      }
    } catch {
      // Prose shorthand such as `{taskId, manifest}`, not a JSON example.
    }
  }
  return found;
}

function isSchedule(value: Record<string, unknown>): boolean {
  return ["cron", "timezone", "at", "intervalMs", "match"].some((k) => k in value);
}

function knownTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

describe("task-authoring skill examples", () => {
  const examples = jsonExamples(SKILL);
  const creates = examples.filter((e) => "manifest" in e && "body" in e);
  const schedules = [
    ...examples.filter(isSchedule),
    ...creates.flatMap((c) => {
      const schedule = (c.manifest as { schedule?: Record<string, unknown> }).schedule;
      return schedule ? [schedule] : [];
    }),
  ];

  it("finds the create call and the schedules the guide shows", () => {
    expect(validateCreate).toBeDefined();
    expect(validateSchedule).toBeDefined();
    expect(creates.length).toBeGreaterThan(0);
    expect(schedules.some((s) => "cron" in s)).toBe(true);
  });

  it("shows only create calls the contract's create input accepts", () => {
    for (const example of creates) {
      const ok = validateCreate?.(example);
      expect({ example, errors: ok ? null : validateCreate?.errors }).toEqual({
        example,
        errors: null,
      });
    }
  });

  it("shows only schedules the contract accepts, each cron with a known timezone", () => {
    for (const schedule of schedules) {
      const ok = validateSchedule?.(schedule);
      expect({ schedule, errors: ok ? null : validateSchedule?.errors }).toEqual({
        schedule,
        errors: null,
      });
      if ("cron" in schedule) expect(knownTimezone(String(schedule.timezone))).toBe(true);
    }
  });

  it("is every JSON object the guide holds", () => {
    // A JSON example that is neither a create call nor a schedule would go
    // unchecked; this keeps a new kind from slipping past the guard.
    for (const example of examples) {
      expect("manifest" in example || isSchedule(example)).toBe(true);
    }
  });
});
