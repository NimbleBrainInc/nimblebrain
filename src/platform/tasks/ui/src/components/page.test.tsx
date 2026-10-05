/** The task page's bodies, the row menu's placement, the shared head, and Activity's merge. */
import { beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskDetail, TaskRun } from "../types.ts";

type Mod<T> = T extends Promise<infer U> ? U : never;
const importPage = () => import("./TaskPage.tsx");
const importActivity = () => import("./ActivityView.tsx");
const importChrome = () => import("./Chrome.tsx");
const importMenu = () => import("./RowMenu.tsx");
const importStructured = () => import("./StructuredView.tsx");
let page: Mod<ReturnType<typeof importPage>>;
let activity: Mod<ReturnType<typeof importActivity>>;
let chrome: Mod<ReturnType<typeof importChrome>>;
let menu: Mod<ReturnType<typeof importMenu>>;
let structured: Mod<ReturnType<typeof importStructured>>;

beforeAll(async () => {
  const { window } = new JSDOM("", { url: "http://localhost" });
  // biome-ignore lint/suspicious/noExplicitAny: test-only DOM shim
  const g = globalThis as any;
  g.window = window;
  g.document = window.document;
  g.HTMLElement = window.HTMLElement;
  g.Node = window.Node;
  [page, activity, chrome, menu, structured] = await Promise.all([
    importPage(),
    importActivity(),
    importChrome(),
    importMenu(),
    importStructured(),
  ]);
});

const DETAIL: TaskDetail = {
  id: "digest",
  name: "Digest",
  prompt: "Summarize the week's activity.",
  schedule: { type: "cron", expression: "0 7 * * 1-5" },
  scheduleHuman: "Weekdays at 7:00 AM",
  enabled: true,
  source: "user",
  runCount: 2,
  consecutiveErrors: 0,
  lastRunStatus: "success",
  lastRunAt: null,
  lastRunAtHuman: null,
  nextRunAt: new Date(Date.now() + 86_400_000).toISOString(),
  nextRunAtHuman: null,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  inputSchema: { type: "object", properties: { company: { type: "string" } } },
  criteria: [{ id: "cites", rule: "Cites a source", type: "boolean" }],
  maxIterations: 10,
};

const run = (id: string, label: TaskRun["label"], startedAt: string): TaskRun => ({
  id,
  taskId: "digest",
  status: "success",
  label,
  startedAt,
});

describe("statusLine", () => {
  test("trigger · next run · last run", () => {
    const line = page.statusLine(
      DETAIL,
      run("r1", "Succeeded", new Date(Date.now() - 240_000).toISOString()),
    );
    expect(line).toMatch(/^Weekdays at 7:00 AM · next tomorrow .* · last run 4m ago$/);
  });
  test("a trigger turned off says so instead of a next run", () => {
    expect(page.statusLine({ ...DETAIL, enabled: false })).toBe("Weekdays at 7:00 AM · off");
  });
  test("only a live trigger gets the switch", () => {
    expect(page.hasLiveTrigger(DETAIL)).toBe(true);
    expect(page.hasLiveTrigger({ schedule: undefined })).toBe(false);
    expect(
      page.hasLiveTrigger({ schedule: DETAIL.schedule, onceDone: { at: "x", outcome: "ran" } }),
    ).toBe(false);
  });
});

const SHEET_ACTIONS = {
  onRunNow: () => {},
  onRunList: () => {},
  onEdit: () => {},
  onDuplicate: () => {},
  onDelete: () => {},
  onSetEnabled: async () => {},
  onOpenRun: () => {},
  onSeeRuns: () => {},
};

const STATS = {
  taskId: "digest",
  runs: 4,
  pass: 3,
  fail: 1,
  uncertain: 0,
  passRate: 0.75,
  costUsd: 1.2,
};

describe("TaskPageBody", () => {
  test("a run needing review: the callout, the latest result, recent runs, setup", () => {
    const review = {
      ...run("r2", "Needs review", new Date().toISOString()),
      resultPreview: "Three prospects found.",
      assessment: {
        verdict: "uncertain" as const,
        assessedAt: "x",
        reason: { code: "no_judge", message: "no judge connected" },
      },
    };
    const runs = [review, run("r1", "Succeeded", new Date(Date.now() - 86_400_000).toISOString())];
    const health = page.taskHealth(
      undefined,
      DETAIL,
      { ...STATS, lastRun: { id: "r2", startedAt: review.startedAt, label: "Needs review" } },
      runs,
    );
    expect(health.word).toBe("Needs review");
    const html = renderToStaticMarkup(
      createElement(page.TaskPageBody, {
        detail: DETAIL,
        health,
        stats: STATS,
        runs,
        runsError: null,
        latestResult: {
          runId: "r2",
          taskId: "digest",
          completedAt: "",
          output: '{"grade":"B"}',
          activityLog: [],
          outputFiles: [],
          usage: { inputTokens: 0, outputTokens: 0, iterations: 0 },
          structured: { grade: "B", note: "Three prospects found." },
        },

        actions: SHEET_ACTIONS,
      }),
    );
    expect(html).toContain("callout tone-warning");
    expect(html).toContain("Check the latest result and accept or reject it.");
    expect(html).toContain("Latest result");
    expect(html).toContain("<dt>note</dt>");
    expect(html).toContain("Three prospects found.");
    expect(html).toContain("Show raw");
    expect(html.match(/class="task-run"/g)).toHaveLength(2);
    expect(html).toContain("75%");
    expect(html).toContain("What it does");
  });

  test("no runs yet, and a run in flight reads Running", () => {
    const quiet = page.taskHealth(undefined, DETAIL, null, []);
    const html = renderToStaticMarkup(
      createElement(page.TaskPageBody, {
        detail: DETAIL,
        health: quiet,
        stats: null,
        runs: [],
        runsError: null,
        actions: SHEET_ACTIONS,
      }),
    );
    expect(html).toContain("No runs yet");
    expect(html).not.toContain("callout");
    const open = { ...run("r3", "Running", new Date().toISOString()), status: "running" };
    expect(page.taskHealth(undefined, DETAIL, null, [open]).word).toBe("Running");
  });
});

describe("SetupSections", () => {
  test("the prompt is prose, schemas are code, criteria and limits read plainly, all folded", () => {
    const html = renderToStaticMarkup(createElement(page.SetupSections, { d: DETAIL }));
    expect(html).toContain('<p class="prose">Summarize the week&#x27;s activity.</p>');
    expect(html).toContain('<pre class="code-block">');
    expect(html).toContain("Cites a source");
    expect(html).toContain("passes when yes");
    expect(html).toContain("10 steps per run");
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).not.toContain("Edit task");
  });
});

describe("taskMenuItems", () => {
  test("lists the task's actions, the trigger toggle only when given", () => {
    const noop = () => {};
    const base = { runList: noop, edit: noop, duplicate: noop, remove: noop };
    expect(page.taskMenuItems(base).map((i: { label: string }) => i.label)).toEqual([
      "Run on a list…",
      "Edit",
      "Duplicate",
      "Delete…",
    ]);
    expect(
      page
        .taskMenuItems({ ...base, runNow: noop, toggle: { enabled: true, onToggle: noop } })
        .map((i: { label: string }) => i.label),
    ).toEqual(["Run now", "Run on a list…", "Edit", "Duplicate", "Turn trigger off", "Delete…"]);
  });
});

describe("PageHeader", () => {
  const head = (hostShowsTrail: boolean) =>
    renderToStaticMarkup(
      createElement(
        chrome.HostTrailContext.Provider,
        { value: hostShowsTrail },
        createElement(chrome.PageHeader, {
          title: "Digest",
          onBack: () => {},
          status: "status",
          actions: "ACTIONS",
        }),
      ),
    );
  test("heading and status on the left, actions on the right, in that order", () => {
    const html = head(true);
    expect(html).toMatch(/page-heading">Digest<.*page-status">status<.*page-actions">ACTIONS</);
  });
  test("a back control only where the host shows no breadcrumb", () => {
    expect(head(true)).not.toContain('aria-label="Back"');
    expect(head(false)).toContain('aria-label="Back"');
  });
});

describe("menuPosition", () => {
  const viewport = { width: 400, height: 600 };
  test("opens below its button, right-aligned", () => {
    expect(menuPosition({ top: 100, bottom: 128, right: 380 }, viewport, 4)).toEqual({
      position: "fixed",
      right: 20,
      top: 132,
    });
  });
  test("opens upward when there is no room below", () => {
    expect(menuPosition({ top: 560, bottom: 588, right: 380 }, viewport, 4)).toEqual({
      position: "fixed",
      right: 20,
      bottom: 44,
    });
  });
  function menuPosition(...a: Parameters<typeof menu.menuPosition>) {
    return menu.menuPosition(...a);
  }
});

describe("mergeNewest", () => {
  test("keeps older loaded pages, takes the newest copy, adds new runs on top", () => {
    const loaded = [
      run("b", "Running", "2026-10-03T00:00:00Z"),
      run("a", "Failed", "2026-10-01T00:00:00Z"),
    ];
    const newest = [
      run("c", "Succeeded", "2026-10-04T00:00:00Z"),
      run("b", "Succeeded", "2026-10-03T00:00:00Z"),
    ];
    const merged = activity.mergeNewest(loaded, newest);
    expect(merged.map((r) => [r.id, r.label])).toEqual([
      ["c", "Succeeded"],
      ["b", "Succeeded"],
      ["a", "Failed"],
    ]);
  });
});

describe("ResultPreview", () => {
  const preview = (p: { structured?: unknown; text?: string }) =>
    renderToStaticMarkup(createElement(structured.ResultPreview, p));
  test("structured output reads as values, the JSON behind Show raw", () => {
    const html = preview({ structured: { grade: "B" } });
    expect(html).toContain("<dt>grade</dt>");
    expect(html).toMatch(
      /<details class="raw"><summary>Show raw<\/summary><pre class="code-block">/,
    );
  });
  test("text that is JSON, fenced or not, reads as values too", () => {
    expect(preview({ text: '```json\n{"grade": "B"}\n```' })).toContain("<dt>grade</dt>");
    expect(preview({ text: '[{"a": 1}]' })).toContain('<th scope="col">a</th>');
  });
  test("plain text is wrapped prose", () => {
    expect(preview({ text: "All good." })).toBe('<p class="prose result-preview">All good.</p>');
  });
});
