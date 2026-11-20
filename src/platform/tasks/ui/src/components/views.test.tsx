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
  schedule: "Weekdays at 7:20 AM",
  scheduleType: "cron",
  enabled: false,
  source: "user",
  runCount: 3,
  lastRunStatus: "success",
  lastRunAt: null,
  nextRunAt: null,
};

const ACTIONS = {
  onOpenTask: noop,
  onOpenRun: noop,
  onCreate: noop,
  onSeeActivity: noop,
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
  test("a poor result leads under Needs you, with its reason and what happened", () => {
    const html = body({ tasks: [live], stats: STATS("Poor result") });
    expect(html).toContain("1 needs you");
    expect(html).toContain("attn-card tone-danger");
    expect(html).toContain("The latest result didn&#x27;t meet its rules.");
    expect(html).toContain("See what happened");
  });
  test("an active task reads as one line: when it runs, and its last runs as a strip", () => {
    const recent = new Map([
      [
        "digest",
        [
          {
            id: "r1",
            taskId: "digest",
            status: "success",
            label: "Succeeded" as const,
            startedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            id: "r2",
            taskId: "digest",
            status: "failure",
            label: "Failed" as const,
            startedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      ],
    ]);
    const html = body({ tasks: [live], stats: STATS("Succeeded"), recent });
    expect(html).toContain("Everything is on track");
    expect(html).toMatch(/Active<\/h2>/);
    expect(html).toContain("home-row tone-success");
    expect(html).toContain("Weekdays at 7:20 AM");
    expect(html).toContain('aria-label="Last 2 runs: Done, Didn&#x27;t work"');
    expect(html).not.toContain("attn-card");
  });
  test("a manual task says it runs only when you run it", () => {
    const html = body({ tasks: [{ ...live, scheduleType: "none", schedule: "Manual" }] });
    expect(html).toContain("Only when you run it");
  });
  test("a paused task is folded under Paused", () => {
    const html = body({ tasks: [TASK], stats: STATS("Succeeded") });
    expect(html).toMatch(/Paused<\/h2><div class="card-aside"><span class="muted">1</);
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
            state: "running",
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
    expect(html).toContain("home-row tone-active");
  });
  test("describing one goes to chat where the host takes a message, else to the form", () => {
    expect(body({ actions: { ...ACTIONS, onDescribe: noop } })).toContain(
      "The agent sets it up in chat",
    );
    expect(body({})).not.toContain("The agent sets it up in chat");
  });
});

describe("recentByTask", () => {
  test("keeps each task's newest runs, oldest first", () => {
    const runs = Array.from({ length: 14 }, (_, i) => ({
      id: `r${i}`,
      taskId: i % 2 ? "a" : "b",
      status: "success",
      startedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    }));
    const byTask = home.recentByTask(runs);
    expect(byTask.get("a")?.map((r) => r.id)).toEqual(["r1", "r3", "r5", "r7", "r9", "r11", "r13"]);
    const many = home.recentByTask(
      Array.from({ length: 12 }, (_, i) => ({
        id: `x${i}`,
        taskId: "a",
        status: "success",
        startedAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      })),
    );
    expect(many.get("a")).toHaveLength(home.STRIP_RUNS);
    expect(many.get("a")?.[0]?.id).toBe("x2");
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
          batch: { ...BATCH, createdAt: RUN.startedAt, updatedAt: RUN.startedAt },
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
    expect(body({ status: "open", result: null })).toContain(
      "Its steps and result appear here when it ends.",
    );
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
    expect(html).toMatch(/Every claim cites a source.*<td>No<\/td><td class="num">91%/);
    expect(html).toContain("<td>high</td>");
    expect(html).toContain("No fetched source");
    expect(html).toContain("Judged by judge · default 1.0");
    expect(html).toContain("Accept");
    expect(html).toContain("Re-judge");
    expect(html).toContain("1 tool call");
    expect(html).toContain('Fetch<span class="muted"> in web</span>');
    // The report card: outcome, verdict, input, time, and cost (run plus judge).
    expect(html).toMatch(/Outcome<\/span><span class="tile-value">Completed/);
    expect(html).toMatch(/Input<\/span><span class="tile-value">Acme/);
    expect(html).toMatch(/Cost<\/span><span class="tile-value">\$0\.43/);
    expect(html).toContain("Includes $0.02 for the judge");
    expect(html).toContain("Show raw");
    expect(html).not.toContain("How it ran");
    expect(html).toContain("Open the run this retried");
  });

  test("a person's verdict shows in the tile and the assessment header alike", () => {
    const html = render(
      createElement(result.ResultBody, {
        ...props,
        state: {
          status: "ready",
          run: {
            ...RUN,
            label: "Poor result",
            assessment: {
              verdict: "uncertain",
              assessedAt: "x",
              human: { verdict: "fail", by: "u", via: "ui", at: "x" },
            },
          },
          result: RESULT,
        },
      }),
    );
    expect(html).toMatch(
      /Verdict<\/span><span class="tile-value"><span class="status-badge tone-danger">.*Rejected by you/,
    );
    expect(html).toContain("The judge said uncertain");
    expect(html).toMatch(
      /Assessment<\/h2><div class="card-aside"><span class="status-badge tone-danger">.*Rejected by you/,
    );
    expect(html).not.toContain(">Uncertain<");
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
    expect(html).toContain(
      "No judge is connected, so these rules couldn&#x27;t be checked. Connect a judge in Connectors.",
    );
    expect(html).not.toContain("no_judge");
    expect(html).toContain("Uncertain");
    expect(html).not.toContain(">Accept<");
  });
  /** The result a run that failed before the engine returned, or never started, leaves. */
  const emptyResult = (error: string) => ({
    runId: "run_10",
    taskId: "research",
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

  test("a failed run shows its error and no deliverable, and takes no verdict", () => {
    const html = body({
      status: "ready",
      run: { ...ENDED_EARLY, status: "failure", execution: "failed", error: "Connector gone" },
      result: emptyResult("Connector gone"),
    });
    expect(html).toMatch(/Outcome<\/span><span class="tile-value">Failed/);
    expect(html).toContain("Connector gone");
    expect(html).toContain("No deliverable for this run.");
    expect(html).not.toContain(">Accept<");
  });

  test("a skipped run shows why it did not start", () => {
    const html = body({
      status: "ready",
      run: {
        ...ENDED_EARLY,
        trigger: undefined,
        status: "skipped",
        execution: "skipped",
        error: "Previous run still active",
      },
      result: emptyResult("Previous run still active"),
    });
    expect(html).toMatch(/Outcome<\/span><span class="tile-value">Did not start/);
    expect(html).toContain("Previous run still active");
    expect(html).toContain("This run did not start, so it left no deliverable.");
    expect(html).not.toContain(">Accept<");
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
