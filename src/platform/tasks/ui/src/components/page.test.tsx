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
let page: Mod<ReturnType<typeof importPage>>;
let activity: Mod<ReturnType<typeof importActivity>>;
let chrome: Mod<ReturnType<typeof importChrome>>;
let menu: Mod<ReturnType<typeof importMenu>>;

beforeAll(async () => {
  const { window } = new JSDOM("", { url: "http://localhost" });
  // biome-ignore lint/suspicious/noExplicitAny: test-only DOM shim
  const g = globalThis as any;
  g.window = window;
  g.document = window.document;
  g.HTMLElement = window.HTMLElement;
  g.Node = window.Node;
  [page, activity, chrome, menu] = await Promise.all([
    importPage(),
    importActivity(),
    importChrome(),
    importMenu(),
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
    expect(line).toMatch(/^Weekdays at 7:00 AM · next tomorrow .* · last run Succeeded 4m ago$/);
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

describe("OverviewBody", () => {
  test("figures, the last runs as links, and runs needing review", () => {
    const html = renderToStaticMarkup(
      createElement(page.OverviewBody, {
        detail: DETAIL,
        stats: {
          taskId: "digest",
          runs: 4,
          pass: 3,
          fail: 1,
          uncertain: 0,
          passRate: 0.75,
          costUsd: 1.2,
        },
        runs: [
          run("r1", "Succeeded", new Date().toISOString()),
          {
            ...run("r2", "Needs review", new Date().toISOString()),
            assessment: {
              verdict: "uncertain",
              assessedAt: "x",
              reason: { code: "no_judge", message: "no judge connected" },
            },
          },
        ],
        runsError: null,
        onOpenRun: () => {},
      }),
    );
    expect(html).toContain("75%");
    expect(html).toContain("$1.20");
    expect(html).toContain("Needs your review");
    expect(html).toContain("no judge connected");
    expect(html.match(/class="run-chip"/g)).toHaveLength(2);
  });
  test("no runs yet", () => {
    const html = renderToStaticMarkup(
      createElement(page.OverviewBody, {
        detail: DETAIL,
        stats: null,
        runs: [],
        runsError: null,
        onOpenRun: () => {},
      }),
    );
    expect(html).toContain("No runs yet.");
    expect(html).not.toContain("Needs your review");
  });
});

describe("DefinitionBody", () => {
  test("the prompt is prose, schemas are code, criteria and limits read plainly", () => {
    const html = renderToStaticMarkup(
      createElement(page.DefinitionBody, { d: DETAIL, onEdit: () => {} }),
    );
    expect(html).toContain('<p class="prose">Summarize the week&#x27;s activity.</p>');
    expect(html).toContain('<pre class="code-block">');
    expect(html).toContain("Cites a source");
    expect(html).toContain("passes when yes");
    expect(html).toContain("10 steps per run");
    expect(html).toContain("<summary");
    expect(html).toContain(">Edit<");
  });
});

describe("taskMenuItems", () => {
  test("lists the task's actions, the trigger toggle only when given", () => {
    const noop = () => {};
    const base = { runList: noop, edit: noop, duplicate: noop, remove: noop };
    expect(page.taskMenuItems(base).map((i) => i.label)).toEqual([
      "Run on a list…",
      "Edit",
      "Duplicate",
      "Delete…",
    ]);
    expect(
      page
        .taskMenuItems({ ...base, runNow: noop, toggle: { enabled: true, onToggle: noop } })
        .map((i) => i.label),
    ).toEqual(["Run now", "Run on a list…", "Edit", "Duplicate", "Turn trigger off", "Delete…"]);
  });
});

describe("ScreenHead", () => {
  const head = (hostShowsTrail: boolean) =>
    renderToStaticMarkup(
      createElement(
        chrome.HostTrailContext.Provider,
        { value: hostShowsTrail },
        createElement(chrome.ScreenHead, { title: "Digest", onBack: () => {}, sub: "status" }),
      ),
    );
  test("with the host's breadcrumb there is no back button and no title", () => {
    const html = head(true);
    expect(html).not.toContain("Back");
    expect(html).not.toContain("Digest");
    expect(html).toContain("status");
  });
  test("without it the screen keeps both", () => {
    const html = head(false);
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain("Digest");
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
