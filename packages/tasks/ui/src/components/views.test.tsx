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
import type { TaskBatch, TaskRun, TaskSummary } from "../types.ts";

type Mod<T> = T extends Promise<infer U> ? U : never;
let home: Mod<ReturnType<typeof importHome>>;
let activity: Mod<ReturnType<typeof importActivity>>;
let result: Mod<ReturnType<typeof importResult>>;
let input: Mod<ReturnType<typeof importInput>>;
const importHome = () => import("./HomeView.tsx");
const importActivity = () => import("./ActivityView.tsx");
const importResult = () => import("./ResultView.tsx");
const importInput = () => import("./InputEditor.tsx");

/** A running batch of the `digest` task: 7 of 10 items done. */
const BATCH: TaskBatch = {
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
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  done: 7,
  passRate: 5 / 6,
};

beforeAll(async () => {
  const { window } = new JSDOM("", { url: "http://localhost" });
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
  });
  [home, activity, result, input] = await Promise.all([
    importHome(),
    importActivity(),
    importResult(),
    importInput(),
  ]);
});

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = () => {};

const TASK: TaskSummary = {
  id: "digest",
  name: "Digest",
  scheduleHuman: "Weekdays at 7:20 AM",
  scheduleType: "cron",
  enabled: false,
  runCount: 3,
};

const ACTIONS = {
  onOpenTask: noop,
  onOpenRun: noop,
  onRunNow: noop,
  onSetEnabled: async () => true,
  onCreate: noop,
  onSeeActivity: noop,
  onOpenBatch: noop,
  onOpenOneoff: noop,
  onEditTask: noop,
};

const STATS = (label: "Succeeded" | "Poor result" | "Needs review") =>
  new Map([
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
        lastRun: { id: "run_1", startedAt: new Date().toISOString(), label },
      },
    ],
  ]);

describe("Home", () => {
  const body = (p: Partial<Parameters<typeof home.HomeBody>[0]>) =>
    render(
      createElement(home.HomeBody, {
        tasks: [],
        loading: false,
        error: null,
        stats: new Map(),
        upcoming: null,
        readError: null,
        actions: ACTIONS,
        ...p,
      }),
    );
  const live = { ...TASK, enabled: true };

  test("loading shows skeletons", () => {
    expect(body({ loading: true })).toContain('aria-busy="true"');
  });
  test("empty asks what should run, with examples and the form a click away", () => {
    const html = body({});
    expect(html).toContain("Nothing scheduled yet");
    expect(html).toContain("What should run, and when?");
    expect(html).toContain("Every Friday at 4pm, recap the week");
    expect(html).toContain("Fill in a form instead");
    // The host's sandbox withholds allow-forms: a <form> submit never fires.
    expect(html).not.toContain("<form");
  });
  test("an error with nothing loaded says so", () => {
    expect(body({ error: "boom" })).toContain('role="alert"');
  });
  test("a poor result leads, its reason on its row, with Edit instructions", () => {
    const html = body({ tasks: [live], stats: STATS("Poor result") });
    expect(html).toContain("1 needs you");
    expect(html).toContain("board-row tone-danger");
    expect(html).toContain("Didn&#x27;t work");
    expect(html).toContain("The output didn&#x27;t match the expected shape.");
    expect(html).toContain(">Edit instructions<");
    // No chat in this host: no Ask in chat.
    expect(html).not.toContain(">Ask in chat<");
  });
  test("a run that needs you names what failed and why, with both fixes", () => {
    const stats = STATS("Needs review");
    const recent = new Map([
      [
        "digest",
        [
          {
            id: "run_1",
            taskId: "digest",
            execution: "completed",
            label: "Needs review" as const,
            startedAt: new Date().toISOString(),
            toolFailures: [
              { name: "tasks__create", errorReason: "denied" },
              { name: "tasks__cancel", errorReason: "denied" },
            ],
          },
        ],
      ],
    ]);
    const html = body({
      tasks: [live],
      stats,
      recent,
      actions: { ...ACTIONS, onAsk: noop },
    });
    expect(html).toContain("board-row tone-warning");
    expect(html).toContain(", Needs you");
    expect(html).toContain(
      "This task tried to create and cancel scheduled tasks, which scheduled runs can&#x27;t do.",
    );
    expect(html).toContain(">Edit instructions<");
    expect(html).toContain(">Ask in chat<");
  });
  test("a healthy task reads as one short line and its last runs as squares", () => {
    const recent = new Map([
      [
        "digest",
        [
          {
            id: "r1",
            taskId: "digest",
            execution: "completed",
            label: "Succeeded" as const,
            startedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "r2",
            taskId: "digest",
            execution: "completed",
            label: "Succeeded" as const,
            startedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      ],
    ]);
    const html = body({ tasks: [live], stats: STATS("Succeeded"), recent });
    expect(html).toContain("Everything is on track");
    expect(html).toContain("board-row tone-success");
    // The server's "Weekdays at 7:20 AM" shortens to "Weekdays 7:20 AM".
    expect(html).toContain("Weekdays 7:20 AM");
    expect(html).toContain('aria-label="Last 2 runs: Done, Done"');
    expect(html.match(/class="cell empty"/g)).toHaveLength(home.STRIP_RUNS - 2);
    expect(html).toContain('role="switch" aria-checked="true"');
  });
  test("an on-demand task has Run, not a switch, and says it runs on demand", () => {
    const html = body({ tasks: [{ ...live, scheduleType: "none", scheduleHuman: "Manual only" }] });
    expect(html).toContain("On demand");
    expect(html).toContain(">Run<");
    expect(html).not.toContain('role="switch"');
  });
  test("a once task that ran or was missed has Run, not a switch it cannot turn on", () => {
    for (const outcome of ["ran", "missed"] as const) {
      const once = {
        ...TASK,
        scheduleType: "once" as const,
        onceDone: { at: "2026-01-01T00:00:00.000Z", outcome },
      };
      const html = body({ tasks: [once] });
      expect(html).toContain(">Run<");
      expect(html).not.toContain('role="switch"');
    }
  });
  test("a paused task is a hollow light at the end, with its switch off", () => {
    const html = body({ tasks: [TASK], stats: STATS("Succeeded") });
    expect(html).toContain("is-off");
    expect(html).toContain('class="light hollow"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("· paused");
  });
  test("a run in flight says so on its row", () => {
    const html = body({
      tasks: [live],
      stats: STATS("Succeeded"),
      upcoming: {
        running: [
          {
            taskId: "digest",
            runId: "run_9",
            startedAt: new Date().toISOString(),
          },
        ],
        queued: [],
        days: 7,
        windowEnd: "",
        scheduled: [],
        frequent: [],
        events: [],
      },
    });
    expect(html).toContain("running now");
    expect(html).toContain("board-row tone-active");
  });
  test("the filter offers only the kinds present, with counts", () => {
    const html = body({
      tasks: [
        live,
        { ...live, id: "x", name: "X", scheduleType: "none", scheduleHuman: "Manual only" },
      ],
    });
    expect(html).toContain('All <span class="muted">2</span>');
    expect(html).toContain('Scheduled <span class="muted">1</span>');
    expect(html).toContain('On demand <span class="muted">1</span>');
    expect(html).not.toContain("On events");
  });
  test("describing one goes to chat where the host takes a message, else to the form", () => {
    expect(body({ actions: { ...ACTIONS, onDescribe: noop } })).toContain(
      "The agent sets it up in chat",
    );
    expect(body({})).not.toContain("The agent sets it up in chat");
  });
});

describe("Runs", () => {
  test("the switch shows on the board and on Runs, which replaces the board", () => {
    const board = render(
      createElement(home.HomeBody, {
        tasks: [{ ...TASK, enabled: true }],
        loading: false,
        error: null,
        stats: new Map(),
        upcoming: null,
        readError: null,
        actions: ACTIONS,
      }),
    );
    expect(board).toContain('role="tablist"');
    expect(board).toContain('aria-selected="true" class="on">Scheduled<');
    const runs = render(
      createElement(home.HomeBody, {
        tasks: [{ ...TASK, enabled: true }],
        loading: false,
        error: null,
        stats: new Map(),
        upcoming: null,
        readError: null,
        actions: ACTIONS,
        tab: "runs",
        runs: createElement("p", null, "the runs list"),
      }),
    );
    expect(runs).toContain("the runs list");
    expect(runs).not.toContain("board-row");
  });
});

describe("recentByTask", () => {
  test("keeps each task's newest runs, oldest first", () => {
    const runs = Array.from({ length: 14 }, (_, i) => ({
      id: `r${i}`,
      taskId: i % 2 ? "a" : "b",
      execution: "completed",
      label: "Succeeded",
      startedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    }));
    const byTask = home.recentByTask(runs);
    expect(byTask.get("a")?.map((r) => r.id)).toEqual(["r1", "r3", "r5", "r7", "r9", "r11", "r13"]);
    const many = home.recentByTask(
      Array.from({ length: home.STRIP_RUNS + 2 }, (_, i) => ({
        id: `x${i}`,
        taskId: "a",
        execution: "completed",
        label: "Succeeded",
        startedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      })),
    );
    expect(many.get("a")).toHaveLength(home.STRIP_RUNS);
    expect(many.get("a")?.[0]?.id).toBe("x2");
  });
});

describe("Activity", () => {
  const STARTED = new Date().toISOString();
  const RUN: TaskRun = {
    id: "run_1",
    taskId: "digest",
    execution: "failed",
    label: "Failed",
    trigger: "scheduled",
    startedAt: STARTED,
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
        { kind: "run", at: STARTED, run: RUN },
        {
          kind: "batch",
          at: STARTED,
          batch: { ...BATCH, createdAt: STARTED, updatedAt: STARTED },
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
  const RUN: TaskRun = {
    id: "run_9",
    taskId: "research",
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
      reason: { code: "schema_invalid", message: "does not match" },
      schema: { valid: false, errors: ["/grade: must be string"] },
    },
  };
  const RESULT = {
    runId: "run_9",
    taskId: "research",
    execution: "completed",
    label: "Poor result",
    completedAt: "2026-10-02T20:52:11Z",
    output: '{"company":"Acme"}',
    activityLog: [{ name: "web__fetch", ok: true, ms: 120 }],
    outputFiles: [{ uri: "files://f1", name: "acme-research.md" }],
    usage: { inputTokens: 1200, outputTokens: 300, iterations: 3 },
    structured: { company: "Acme", prospects: [{ name: "Jane", role: "VP Sales" }] },
  };
  const body = (state: Parameters<typeof result.ResultBody>[0]["state"]) =>
    render(createElement(result.ResultBody, { state, onOpenRun: noop }));

  test("loading, open, and error", () => {
    expect(body({ status: "loading", result: null })).toContain('aria-busy="true"');
    expect(body({ status: "open", result: null })).toContain(
      "Its steps and result appear here when it ends.",
    );
    expect(body({ status: "error", result: null, error: "Run not found" })).toContain(
      "Run not found",
    );
  });

  test("deliverable first, as values and a table, then the read-only assessment", () => {
    const html = body({ status: "ready", run: RUN, result: RESULT });
    expect(html.indexOf("Acme")).toBeLessThan(html.indexOf("Assessment"));
    expect(html).toContain("<dt>company</dt>");
    expect(html).toContain('<th scope="col">role</th>');
    expect(html).toContain("acme-research.md");
    expect(html).toContain("The result doesn&#x27;t match the task&#x27;s output schema.");
    expect(html).toContain("does not match: /grade: must be string");
    expect(html).not.toContain("Accept");
    expect(html).not.toContain("Re-judge");
    expect(html).toContain("1 tool call");
    expect(html).toContain('Fetch<span class="muted"> in web</span>');
    // The report card: outcome, verdict, input, time, and cost.
    expect(html).toMatch(/Outcome<\/span><span class="tile-value">Completed/);
    expect(html).toMatch(/Input<\/span><span class="tile-value">Acme/);
    expect(html).toMatch(/Cost<\/span><span class="tile-value">\$0\.41/);
    expect(html).toMatch(
      /Assessment<\/h2><div class="card-aside"><span class="status-badge tone-danger">.*Failed/,
    );
    expect(html).toContain("Show raw");
    expect(html).toContain("Open the run this retried");
  });

  test("a run that needs you leads with why, read from its steps, and the two fixes", () => {
    const review = {
      ...RUN,
      label: "Needs review",
      assessment: undefined,
      unrecoveredToolFailures: ["tasks__create", "tasks__cancel"],
    };
    const html = render(
      createElement(result.ResultBody, {
        state: {
          status: "ready",
          run: review,
          result: {
            ...RESULT,
            label: "Needs review",
            activityLog: [
              { name: "tasks__create", ok: false, errorReason: "denied", ms: 3 },
              { name: "tasks__cancel", ok: false, errorReason: "denied", ms: 2 },
            ],
          },
        },
        onEdit: noop,
        onAsk: noop,
      }),
    );
    expect(html.indexOf("callout tone-warning")).toBeLessThan(html.indexOf("Run summary"));
    expect(html).toContain(
      "This task tried to create and cancel scheduled tasks, which scheduled runs can&#x27;t do.",
    );
    expect(html).toContain(">Edit instructions<");
    expect(html).toContain(">Ask in chat<");
    // A run whose task is gone, or a host without chat, offers only what it can do.
    const readOnly = render(
      createElement(result.ResultBody, {
        state: { status: "ready", run: review, result: RESULT },
      }),
    );
    expect(readOnly).toContain("This task had Create in tasks and Cancel in tasks fail.");
    expect(readOnly).not.toContain(">Edit instructions<");
  });

  test("a verdict this screen does not know is shown verbatim", () => {
    const html = body({
      status: "ready",
      run: { ...RUN, assessment: { verdict: "graded" } },
      result: { ...RESULT, structured: undefined, output: "plain text" },
    });
    expect(html).toContain("graded");
  });

  /** The result a run that failed before the engine returned, or never started, leaves. */
  const emptyResult = (error: string, execution: string) => ({
    runId: "run_10",
    taskId: "research",
    execution,
    label: execution === "failed" ? "Failed" : "Skipped",
    completedAt: "2026-10-02T20:52:11Z",
    output: "",
    activityLog: [],
    outputFiles: [],
    usage: { inputTokens: 0, outputTokens: 0, iterations: 0 },
    error,
  });
  const ENDED_EARLY = {
    id: "run_10",
    taskId: "research",
    trigger: "manual",
    startedAt: "2026-10-02T20:51:00Z",
    completedAt: "2026-10-02T20:51:01Z",
  } as const;

  test("a failed run shows its error and no deliverable", () => {
    const html = body({
      status: "ready",
      run: { ...ENDED_EARLY, execution: "failed", label: "Failed", error: "Connector gone" },
      result: emptyResult("Connector gone", "failed"),
    });
    expect(html).toMatch(/Outcome<\/span><span class="tile-value">Failed/);
    expect(html).toContain("Connector gone");
    expect(html).toContain("No deliverable for this run.");
  });

  test("a skipped run shows why it did not start", () => {
    const html = body({
      status: "ready",
      run: {
        ...ENDED_EARLY,
        trigger: undefined,
        execution: "skipped",
        label: "Skipped",
        error: "Previous run still active",
      },
      result: emptyResult("Previous run still active", "skipped"),
    });
    expect(html).toMatch(/Outcome<\/span><span class="tile-value">Did not start/);
    expect(html).toContain("Previous run still active");
    expect(html).toContain("This run did not start, so it left no deliverable.");
  });

  test("the deliverable is the result's output, never the run's preview", () => {
    const html = body({
      status: "ready",
      run: { ...RUN, assessment: undefined, resultPreview: "Three prospects found." },
      result: null,
    });
    expect(html).not.toContain("Three prospects found.");
    expect(html).toContain("No deliverable for this run.");
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
