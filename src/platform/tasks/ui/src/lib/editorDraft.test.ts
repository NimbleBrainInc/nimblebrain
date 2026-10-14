/**
 * The editor sends create a whole definition, update only what changed (null
 * to clear what can be cleared), and a test run the draft as an inline run.
 */
import { describe, expect, test } from "bun:test";
import type { TaskDetail } from "../types.ts";
import { createArgs, draftFromDetail, emptyDraft, testRunArgs, updateArgs } from "./editorDraft.ts";

const DETAIL: TaskDetail = {
  id: "research",
  name: "Research",
  prompt: "Research {{company}}",
  scheduleHuman: "Daily",
  timezone: "UTC",
  schedule: { type: "cron", expression: "0 8 * * *", timezone: "UTC" },
  enabled: true,
  source: "user",
  runCount: 0,
  consecutiveErrors: 0,
  lastRunStatus: null,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "",
  updatedAt: "",
  inputSchema: {
    type: "object",
    properties: { company: { type: "string" } },
    required: ["company"],
    additionalProperties: false,
  },
  criteria: [{ id: "cites", rule: "Cites a source", type: "boolean" }],
  onPoorResult: "retry_once",
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
        schedule: { type: "interval", intervalMs: 3_600_000 },
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
      schedule: { type: "event", match: { source: "mail", name: "mail.*" }, maxFiresPerHour: 6 },
    });
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
      criteria: [],
      onPoorResult: "" as const,
      allowedTools: "",
      maxIterations: "20",
    };
    expect(updateArgs("research", original, edited).args).toEqual({
      taskId: "research",
      manifest: {
        schedule: null,
        criteria: null,
        onPoorResult: null,
        allowedTools: null,
        maxIterations: 20,
      },
      body: "Research {{company}} deeply",
    });
  });
});

describe("testRunArgs", () => {
  test("runs the draft inline with its input, recording verdicts only", () => {
    const d = draftFromDetail(DETAIL);
    expect(testRunArgs(d, { company: "Acme" }).args).toEqual({
      definition: {
        body: "Research {{company}}",
        manifest: {
          inputSchema: DETAIL.inputSchema,
          allowedTools: ["web__*"],
          maxIterations: 10,
          criteria: DETAIL.criteria,
          onPoorResult: "record",
        },
      },
      input: { company: "Acme" },
    });
  });

  test("reports what is wrong instead of running", () => {
    const d = { ...emptyDraft(), prompt: "x", outputJson: "{nope" };
    expect(testRunArgs(d, undefined).problems[0]).toContain("output schema is not valid JSON");
  });
});
