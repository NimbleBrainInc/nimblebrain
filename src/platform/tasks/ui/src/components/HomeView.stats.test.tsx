/**
 * The home view's 30-day figures follow the clock as well as the data: the
 * window's start moves, so a run leaves it with no data change announced. The
 * view mounts here against stub tools, with the timers faked.
 */
import { afterEach, beforeAll, expect, jest, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type * as ReactDOMClient from "react-dom/client";
import type { TaskStats, TaskSummary } from "../types.ts";
import type * as HomeModule from "./HomeView.tsx";

let home: typeof HomeModule;
let createRoot: typeof ReactDOMClient.createRoot;
/** What `tasks__stats` answers next, and how often each tool was called. */
let statsAnswer: TaskStats[] = [];
const calls: Record<string, number> = {};

const TASK: TaskSummary = {
  id: "digest",
  name: "Digest",
  schedule: "Weekdays at 7:20 AM",
  scheduleType: "cron",
  enabled: true,
  source: "user",
  runCount: 1,
  lastRunStatus: "success",
  lastRunAt: null,
  nextRunAt: null,
};

const noop = () => {};
const ACTIONS = {
  onOpenTask: noop,
  onOpenRun: noop,
  onCreate: noop,
  onSeeUpcoming: noop,
  onSeeActivity: noop,
};

beforeAll(async () => {
  const { window } = new JSDOM("", { url: "http://localhost" });
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  // `useCallTool` needs a connected host; one stable `call` per tool stands in.
  const real = await import("@nimblebrain/synapse/react");
  const tools = new Map<string, { call: () => Promise<unknown> }>();
  const toolOf = (name: string) => {
    let tool = tools.get(name);
    if (!tool) {
      tool = {
        call: async () => {
          calls[name] = (calls[name] ?? 0) + 1;
          const data = name === "stats" ? { tasks: statsAnswer } : {};
          return { data, isError: false, content: [] };
        },
      };
      tools.set(name, tool);
    }
    return tool;
  };
  mock.module("@nimblebrain/synapse/react", () => ({
    ...real,
    useCallTool: (name: string) => ({ ...toolOf(name), isPending: false, error: null, data: null }),
  }));
  home = await import("./HomeView.tsx");
  ({ createRoot } = await import("react-dom/client"));
});

afterEach(() => {
  jest.useRealTimers();
});

test("a run that ages out of the window leaves the figures with no data change", async () => {
  jest.useFakeTimers();
  statsAnswer = [
    {
      taskId: "digest",
      runs: 1,
      pass: 0,
      fail: 1,
      uncertain: 0,
      passRate: 0,
      costUsd: 0.4,
      lastRun: { id: "run_1", startedAt: new Date().toISOString(), label: "Poor result" },
    },
  ];
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(home.HomeView, {
        tasks: [TASK],
        loading: false,
        error: null,
        refreshKey: 0,
        actions: ACTIONS,
      }),
    ),
  );
  expect(calls.stats).toBe(1);
  expect(container.innerHTML).toContain("attn-card tone-danger");

  // The run is now older than the window: the tool no longer counts it.
  statsAnswer = [
    { taskId: "digest", runs: 0, pass: 0, fail: 0, uncertain: 0, passRate: null, costUsd: 0 },
  ];
  await act(async () => {
    jest.advanceTimersByTime(home.STATS_REFRESH_MS - 1);
  });
  expect(calls.stats).toBe(1);
  expect(container.innerHTML).toContain("attn-card tone-danger");

  await act(async () => {
    jest.advanceTimersByTime(1);
  });
  expect(calls.stats).toBe(2);
  expect(container.innerHTML).not.toContain("attn-card");
  await act(async () => root.unmount());
});
