/**
 * The editor sends create a whole definition, update only what changed (null
 * to clear what can be cleared), and a test run the draft as an inline run.
 */
import { describe, expect, test } from "bun:test";
import type { TaskDetail } from "../types.ts";
import {
  createArgs,
  draftFromDetail,
  emptyDraft,
  scheduleArg,
  testRunArgs,
  updateArgs,
} from "./editorDraft.ts";

const DETAIL: TaskDetail = {
  id: "research",
  name: "Research",
  prompt: "Research {{company}}",
  scheduleHuman: "Daily",
  schedule: { cron: "0 8 * * *", timezone: "UTC" },
  enabled: true,
  runCount: 0,
  consecutiveErrors: 0,
  createdAt: "",
  updatedAt: "",
  inputSchema: {
    type: "object",
    properties: { company: { type: "string" } },
    required: ["company"],
    additionalProperties: false,
  },
  outputSchema: { type: "object" },
  allowedTools: ["web__*"],
  maxIterations: 10,
};

describe("createArgs", () => {
  test("refuses a draft with no name or prompt, naming both", () => {
    expect(createArgs(emptyDraft()).problems).toEqual([
      "Give the task a name.",
      "Say what the task should do.",
    ]);
  });

  test("builds the manifest and body", () => {
    const d = {
      ...emptyDraft(),
      name: "Digest",
      prompt: "Summarize",
      trigger: "schedule" as const,
      schedule: { type: "interval" as const, intervalMs: 3_600_000 },
      allowedTools: "gmail__*, files__read",
      maxRunDurationSec: "60",
    };
    expect(createArgs(d).args).toEqual({
      manifest: {
        name: "Digest",
        enabled: true,
        schedule: { intervalMs: 3_600_000 },
        allowedTools: ["gmail__*", "files__read"],
        maxRunDurationMs: 60_000,
      },
      body: "Summarize",
    });
  });

  test("an event trigger builds its match and ceiling", () => {
    const d = {
      ...emptyDraft(),
      name: "Triage",
      prompt: "Triage it",
      trigger: "event" as const,
      event: {
        source: "mail",
        name: "mail.*",
        level: "" as const,
        debounceSec: "",
        maxFiresPerHour: "6",
      },
    };
    expect(createArgs(d).args?.manifest).toMatchObject({
      schedule: { match: { source: "mail", name: "mail.*" }, maxFiresPerHour: 6 },
    });
  });

  test("a picked cron goes out as `cron`, with its timezone", () => {
    const d = {
      ...emptyDraft(),
      name: "Morning",
      prompt: "Summarize",
      trigger: "schedule" as const,
      schedule: {
        type: "cron" as const,
        expression: "0 8 * * 1-5",
        timezone: "Pacific/Honolulu",
      },
    };
    expect(createArgs(d).args?.manifest).toMatchObject({
      schedule: { cron: "0 8 * * 1-5", timezone: "Pacific/Honolulu" },
    });
  });
});

describe("scheduleArg", () => {
  test("each kind goes out as exactly its own written form", () => {
    expect(scheduleArg({ type: "cron", expression: "0 8 * * *" })).toEqual({
      cron: "0 8 * * *",
      timezone: "UTC",
    });
    expect(
      scheduleArg({ type: "once", at: "2030-01-01T00:00:00.000Z", timezone: "Europe/Berlin" }),
    ).toEqual({ at: "2030-01-01T00:00:00.000Z" });
    expect(scheduleArg({ type: "interval", intervalMs: 60_000 })).toEqual({ intervalMs: 60_000 });
  });
});

describe("draftFromDetail", () => {
  test("reads each written schedule form", () => {
    expect(draftFromDetail(DETAIL).schedule).toEqual({
      type: "cron",
      expression: "0 8 * * *",
      timezone: "UTC",
    });
    const once = draftFromDetail({ ...DETAIL, schedule: { at: "2030-01-01T00:00:00Z" } });
    expect(once.schedule).toEqual({ type: "once", at: "2030-01-01T00:00:00Z" });
    const event = draftFromDetail({
      ...DETAIL,
      schedule: { match: { source: "mail", level: "urgent" }, debounceMs: 5000 },
    });
    expect(event.trigger).toBe("event");
    expect(event.event).toMatchObject({ source: "mail", level: "urgent", debounceSec: "5" });
    expect(draftFromDetail({ ...DETAIL, schedule: undefined }).trigger).toBe("manual");
  });
});

describe("updateArgs", () => {
  test("an unchanged form sends no manifest and no body", () => {
    const d = draftFromDetail(DETAIL);
    expect(updateArgs("research", d, d).args).toEqual({ taskId: "research" });
  });

  test("sends the changed fields, and null for cleared ones", () => {
    const original = draftFromDetail(DETAIL);
    const edited = {
      ...original,
      prompt: "Research {{company}} deeply",
      trigger: "manual" as const,
      outputJson: "",
      allowedTools: "",
      maxIterations: "20",
    };
    expect(updateArgs("research", original, edited).args).toEqual({
      taskId: "research",
      manifest: {
        outputSchema: null,
        allowedTools: null,
        schedule: null,
        maxIterations: 20,
      },
      body: "Research {{company}} deeply",
    });
  });
});

describe("testRunArgs", () => {
  test("runs the draft inline with its input, without its trigger", () => {
    const d = draftFromDetail(DETAIL);
    expect(testRunArgs(d, { company: "Acme" }).args).toEqual({
      definition: {
        body: "Research {{company}}",
        manifest: {
          inputSchema: DETAIL.inputSchema,
          outputSchema: DETAIL.outputSchema,
          allowedTools: ["web__*"],
          maxIterations: 10,
        },
      },
      input: { company: "Acme" },
    });
  });

  test("carries the stored task's reasoning depth, which the form does not edit", () => {
    const d = draftFromDetail({ ...DETAIL, thinkingEffort: "low" });
    const manifest = testRunArgs(d, { company: "Acme" }).args?.definition as {
      manifest: Record<string, unknown>;
    };
    expect(manifest.manifest.thinkingEffort).toBe("low");
    expect(updateArgs("research", d, { ...d, name: "Renamed" }).args?.manifest).toBeUndefined();
  });

  test("reports what is wrong instead of running", () => {
    const d = { ...emptyDraft(), prompt: "x", outputJson: "{nope" };
    expect(testRunArgs(d, undefined).problems[0]).toContain("output schema is not valid JSON");
  });
});
