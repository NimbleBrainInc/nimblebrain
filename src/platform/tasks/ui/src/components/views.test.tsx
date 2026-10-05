/**
 * Each view's key states render: loading, empty, error, loaded. The views
 * are split into a body that takes data and a container that fetches it, so
 * the body renders here without a host. jsdom is installed first because the
 * result screen renders markdown through DOMPurify, which needs a window at
 * import time (see markdown.test.ts).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskRun, TaskSummary, UpcomingData } from "../types.ts";

type Mod<T> = T extends Promise<infer U> ? U : never;
let saved: Mod<ReturnType<typeof importSaved>>;
let upcoming: Mod<ReturnType<typeof importUpcoming>>;
let activity: Mod<ReturnType<typeof importActivity>>;
let result: Mod<ReturnType<typeof importResult>>;
let input: Mod<ReturnType<typeof importInput>>;
let tasksUi: Mod<ReturnType<typeof importTasksUi>>;
const importSaved = () => import("./SavedView.tsx");
const importUpcoming = () => import("./UpcomingView.tsx");
const importActivity = () => import("./ActivityView.tsx");
const importResult = () => import("./ResultView.tsx");
const importInput = () => import("./InputEditor.tsx");
const importTasksUi = () => import("./TasksUI.tsx");

beforeAll(async () => {
  const { window } = new JSDOM("", { url: "http://localhost" });
  // biome-ignore lint/suspicious/noExplicitAny: test-only DOM shim
  const g = globalThis as any;
  g.window = window;
  g.document = window.document;
  g.HTMLElement = window.HTMLElement;
  g.Node = window.Node;
  [saved, upcoming, activity, result, input, tasksUi] = await Promise.all([
    importSaved(),
    importUpcoming(),
    importActivity(),
    importResult(),
    importInput(),
    importTasksUi(),
  ]);
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = () => {};

const TASK: TaskSummary = {
  id: "digest",
  name: "Digest",
  schedule: "Daily at 7:20 AM",
  scheduleType: "cron",
  enabled: false,
  source: "user",
  runCount: 3,
  lastRunStatus: "success",
  lastRunAt: null,
  nextRunAt: null,
};

const ACTIONS = {
  onOpen: noop,
  onRunNow: noop,
  onRunList: noop,
  onEdit: noop,
  onToggle: noop,
  onDelete: noop,
  onOpenRun: noop,
  onCreate: noop,
};

describe("Saved", () => {
  const body = (p: Partial<Parameters<typeof saved.SavedBody>[0]>) =>
    render(
      createElement(saved.SavedBody, {
        tasks: [],
        loading: false,
        error: null,
        stats: new Map(),
        statsError: null,
        busy: {},
        actions: ACTIONS,
        ...p,
      }),
    );

  test("loading shows skeletons", () => {
    expect(body({ loading: true })).toContain('aria-busy="true"');
  });
  test("empty offers templates", () => {
    const html = body({});
    expect(html).toContain("No saved tasks");
    expect(html).toContain("Weekly Summary");
  });
  test("an error with nothing loaded says so", () => {
    expect(body({ error: "boom" })).toContain('role="alert"');
  });
  test("a loaded row shows trigger, paused state, last run label, pass rate and cost", () => {
    const html = body({
      tasks: [TASK],
      stats: new Map([
        [
          "digest",
          {
            taskId: "digest",
            runs: 4,
            pass: 3,
            fail: 1,
            uncertain: 0,
            passRate: 0.75,
            costUsd: 1.2,
            lastRun: { id: "run_1", startedAt: new Date().toISOString(), label: "Poor result" },
          },
        ],
      ]),
    });
    expect(html).toContain("Daily at 7:20 AM");
    expect(html).toContain("Paused");
    expect(html).toContain("Poor result");
    expect(html).toContain("75%");
    expect(html).toContain("$1.20");
    expect(html).toContain("Run now");
  });
  test("a task with no runs yet reads so, and no stats reads a dash", () => {
    const html = body({ tasks: [{ ...TASK, enabled: true }], stats: new Map() });
    expect(html).toContain("No runs yet");
    expect(html).toContain("—");
    expect(html).not.toContain("Paused");
  });
});

describe("Upcoming", () => {
  const DATA: UpcomingData = {
    running: [
      {
        taskId: "research",
        taskName: "Research",
        runId: "run_a",
        state: "running",
        batchId: "batch_4f2a00000000",
        batchIndex: 511,
        startedAt: new Date().toISOString(),
      },
    ],
    queued: [
      {
        taskId: "digest",
        taskName: "Digest",
        runId: "run_b",
        state: "queued",
        position: 1,
        trigger: "manual",
      },
    ],
    scheduled: [
      {
        taskId: "digest",
        taskName: "Digest",
        at: new Date(Date.now() + 3_600_000).toISOString(),
        schedule: "Daily",
        scheduleType: "cron",
      },
    ],
    events: [
      {
        taskId: "triage",
        taskName: "Triage",
        schedule: "On notifications from mail",
        enabled: true,
        maxFiresPerHour: 12,
        firesLastHour: 2,
      },
    ],
  };
  const body = (p: Partial<Parameters<typeof upcoming.UpcomingBody>[0]>) =>
    render(
      createElement(upcoming.UpcomingBody, {
        data: null,
        loading: false,
        error: null,
        batches: new Map(),
        onOpenRun: noop,
        onOpenTask: noop,
        ...p,
      }),
    );

  test("loading, error, and empty", () => {
    expect(body({ loading: true })).toContain('aria-busy="true"');
    expect(body({ error: "down" })).toContain("down");
    expect(body({ data: { running: [], queued: [], scheduled: [], events: [] } })).toContain(
      "Nothing is lined up",
    );
  });
  test("loaded: the queue with batch items, scheduled fires, and event tasks", () => {
    const html = body({
      data: DATA,
      batches: new Map([["batch_4f2a00000000", { items: 1000 } as never]]),
    });
    expect(html).toContain("1 running · 1 waiting");
    expect(html).toContain("Research · batch 4f2a · item 512/1000");
    expect(html).toContain("Waiting · 1");
    expect(html).toContain("Digest · run now");
    expect(html).toContain("Scheduled");
    expect(html).toContain("at most 12/hr");
    expect(html).toContain("2 in the last hour");
  });
});

describe("Activity", () => {
  const RUN: TaskRun = {
    id: "run_1",
    taskId: "digest",
    status: "failure",
    label: "Failed",
    trigger: "scheduled",
    startedAt: new Date().toISOString(),
    error: "web_fetch errors\nmore",
    costUsd: 0,
  };
  const body = (p: Partial<Parameters<typeof activity.ActivityBody>[0]>) =>
    render(
      createElement(activity.ActivityBody, {
        rows: [],
        loading: false,
        error: null,
        filters: { label: "all", taskId: "all", startedBy: "all", range: 7 },
        tasks: [TASK],
        hasMore: false,
        onFilters: noop,
        onMore: noop,
        onOpenRun: noop,
        onOpenBatch: noop,
        ...p,
      }),
    );

  test("loading, empty, filtered-empty, and error", () => {
    expect(body({ loading: true })).toContain('aria-busy="true"');
    expect(body({})).toContain("No runs yet");
    expect(
      body({ filters: { label: "Failed", taskId: "all", startedBy: "all", range: 7 } }),
    ).toContain("No runs match");
    expect(body({ error: "nope" })).toContain('role="alert"');
  });
  test("a run row and a batch row", () => {
    const html = body({
      hasMore: true,
      rows: [
        { kind: "run", at: RUN.startedAt, run: RUN },
        {
          kind: "batch",
          at: RUN.startedAt,
          batch: {
            id: "batch_4f2a00000000",
            taskId: "digest",
            items: 10,
            concurrency: 2,
            state: "running",
            counts: {
              pending: 2,
              queued: 0,
              running: 1,
              pass: 5,
              fail: 1,
              uncertain: 1,
              not_assessed: 0,
              failed: 0,
              skipped: 0,
              cancelled: 0,
            },
            costUsd: 2.5,
            createdAt: RUN.startedAt,
            updatedAt: RUN.startedAt,
            done: 7,
            passRate: 5 / 6,
          },
        },
      ],
    });
    expect(html).toContain("Failed");
    expect(html).toContain("Digest");
    expect(html).toContain("Schedule");
    expect(html).toContain("web_fetch errors");
    expect(html).not.toContain("more</");
    expect(html).toContain("7/10 · 5 pass · 1 fail · 1 uncertain");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Load older runs");
  });
});

describe("Result", () => {
  const props = {
    canAct: true,
    assessBusy: false,
    assessError: null,
    onVerdict: noop,
    onRejudge: noop,
  };
  const RUN: TaskRun = {
    id: "run_9",
    taskId: "research",
    status: "success",
    execution: "completed",
    label: "Poor result",
    trigger: "manual",
    startedAt: "2026-10-02T20:51:00Z",
    completedAt: "2026-10-02T20:52:11Z",
    costUsd: 0.41,
    input: { company: "Acme" },
    retryOf: "run_8",
    assessment: {
      verdict: "fail",
      assessedAt: "2026-10-02T20:53:00Z",
      judge: { server: "judge", id: "default", version: "1.0", calibrated: true },
      usage: { costUsd: 0.02 },
      criteria: [
        {
          id: "cites",
          answer: false,
          passed: false,
          confidence: 0.91,
          rationale: "No fetched source",
        },
        { id: "grade", answer: 2, passed: true, confidence: 0.84 },
      ],
    },
  };
  const RESULT = {
    runId: "run_9",
    taskId: "research",
    completedAt: "2026-10-02T20:52:11Z",
    output: '{"company":"Acme"}',
    activityLog: [
      { id: "t1", name: "web__fetch", input: { url: "x" }, output: "ok", ok: true, ms: 120 },
    ],
    outputFiles: [{ id: "f1", filename: "acme-research.md" }],
    usage: { inputTokens: 1200, outputTokens: 300, iterations: 3 },
    structured: { company: "Acme", prospects: [{ name: "Jane", role: "VP Sales" }] },
  };
  const body = (state: Parameters<typeof result.ResultBody>[0]["state"]) =>
    render(createElement(result.ResultBody, { ...props, state, onOpenRun: noop }));

  test("loading, open, and error", () => {
    expect(body({ status: "loading", result: null })).toContain('aria-busy="true"');
    expect(body({ status: "open", result: null })).toContain("Running…");
    expect(body({ status: "error", result: null, error: "Run not found" })).toContain(
      "Run not found",
    );
  });

  test("deliverable first, as values and a table, then the assessment with rules", () => {
    const html = body({
      status: "ready",
      run: RUN,
      result: RESULT,
      criteria: [
        { id: "cites", rule: "Every claim cites a source", type: "boolean" },
        { id: "grade", rule: "Fit grade matches", type: "score", levels: ["low", "mid", "high"] },
      ],
    });
    expect(html.indexOf("Acme")).toBeLessThan(html.indexOf("Assessment"));
    expect(html).toContain("<dt>company</dt>");
    expect(html).toContain('<th scope="col">role</th>');
    expect(html).toContain("acme-research.md");
    expect(html).toContain("Every claim cites a source");
    expect(html).toContain("Answer: No");
    expect(html).toContain("Answer: high");
    expect(html).toContain("Confidence 91%");
    expect(html).toContain("No fetched source");
    expect(html).toContain("Judged by judge · default 1.0");
    expect(html).toContain("Accept");
    expect(html).toContain("Re-judge");
    expect(html).toContain("1 tool call");
    expect(html).toContain("Cost: $0.43");
    expect(html).toContain("Open the run this retried");
  });

  test("an uncertain assessment shows its reason; a deleted task offers no verdict", () => {
    const html = render(
      createElement(result.ResultBody, {
        ...props,
        canAct: false,
        state: {
          status: "ready",
          run: {
            ...RUN,
            retryOf: undefined,
            assessment: {
              verdict: "uncertain",
              assessedAt: "x",
              reason: { code: "no_judge", message: "no judge server is connected" },
            },
          },
          result: { ...RESULT, structured: undefined, output: "plain text" },
        },
      }),
    );
    expect(html).toContain("no judge server is connected");
    expect(html).toContain("Uncertain");
    expect(html).not.toContain(">Accept<");
  });
});

describe("InputEditor", () => {
  test("draws a form for a flat schema", () => {
    const html = render(
      createElement(input.InputEditor, {
        schema: {
          type: "object",
          properties: { company: { type: "string" }, urgent: { type: "boolean" } },
          required: ["company"],
        },
        onChange: noop,
      }),
    );
    expect(html).toContain("company");
    expect(html).toContain("(required)");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Edit as JSON");
  });
  test("falls back to JSON for a nested schema, and with no schema", () => {
    const nested = render(
      createElement(input.InputEditor, {
        schema: { type: "object", properties: { a: { type: "object", properties: {} } } },
        onChange: noop,
      }),
    );
    expect(nested).toContain("Input (JSON)");
    expect(nested).not.toContain("Use the form");
    expect(render(createElement(input.InputEditor, { onChange: noop }))).toContain(
      "Any JSON value",
    );
  });
  test("parseJsonInput", () => {
    expect(input.parseJsonInput("")).toEqual({ ok: true, input: undefined });
    expect(input.parseJsonInput('{"a":1}')).toEqual({ ok: true, input: { a: 1 } });
    expect(input.parseJsonInput("{").ok).toBe(false);
  });
});

describe("ViewTabs", () => {
  test("is a tab list with the current view selected", () => {
    const html = render(createElement(tasksUi.ViewTabs, { view: "upcoming", onChange: noop }));
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/aria-selected="true"[^>]*>Upcoming/);
    expect(html).toContain("Activity");
  });
});
