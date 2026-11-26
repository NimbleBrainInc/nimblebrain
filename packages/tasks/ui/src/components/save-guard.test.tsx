/**
 * A switch save resolves whether it landed, and the two clicks that wait on it
 * act only when it did: "Turn on and try again" on the board runs the task
 * after a saved turn-on, and the task page's switch moves after a saved save.
 * The task page reads its task through tools, so stub tools stand in for it.
 */
import { beforeAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type * as ReactDOMClient from "react-dom/client";
import type { TaskDetail, TaskSummary } from "../types.ts";
import type * as HomeViewModule from "./HomeView.tsx";
import type * as TaskPageModule from "./TaskPage.tsx";

let HomeBody: typeof HomeViewModule.HomeBody;
let TaskPage: typeof TaskPageModule.TaskPage;
let createRoot: typeof ReactDOMClient.createRoot;

const DETAIL: TaskDetail = {
  id: "digest",
  name: "Digest",
  prompt: "Summarize the week's activity.",
  schedule: { cron: "0 7 * * 1-5", timezone: "UTC" },
  scheduleHuman: "Weekdays at 7:00 AM",
  enabled: true,
  runCount: 0,
  consecutiveErrors: 0,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
};

/** A trigger the runtime turned off: its row offers "Turn on and try again". */
const TURNED_OFF: TaskSummary = {
  id: "digest",
  name: "Digest",
  scheduleHuman: "Weekdays at 7:00 AM",
  scheduleType: "cron",
  enabled: false,
  disabledReason: "Turned off after 3 failed runs in a row.",
  runCount: 3,
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
  const real = await import("@nimblebrain/synapse/react");
  const tools = new Map<string, { call: () => Promise<unknown> }>();
  const toolOf = (name: string) => {
    let tool = tools.get(name);
    if (!tool) {
      tool = {
        call: async () => {
          const data = name === "status" ? { task: DETAIL } : name === "runs" ? { runs: [] } : {};
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
  ({ HomeBody } = await import("./HomeView.tsx"));
  ({ TaskPage } = await import("./TaskPage.tsx"));
  ({ createRoot } = await import("react-dom/client"));
});

const noop = () => {};

/** Click "Turn on and try again" with a save that resolves `saved`; return the runs it started. */
async function enableAndRetry(saved: boolean) {
  let runs = 0;
  const enables: boolean[] = [];
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(HomeBody, {
        tasks: [TURNED_OFF],
        loading: false,
        error: null,
        stats: new Map(),
        upcoming: null,
        readError: null,
        actions: {
          onOpenTask: noop,
          onOpenRun: noop,
          onRunNow: () => {
            runs++;
          },
          onSetEnabled: async (_t, on) => {
            enables.push(on);
            return saved;
          },
          onCreate: noop,
          onSeeActivity: noop,
          onOpenBatch: noop,
          onOpenOneoff: noop,
        },
      }),
    ),
  );
  const button = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Turn on and try again",
  );
  expect(button).toBeDefined();
  await act(async () => button?.click());
  await act(async () => root.unmount());
  return { runs, enables };
}

test("turn on and try again runs the task only after the turn-on saved", async () => {
  expect(await enableAndRetry(false)).toEqual({ runs: 0, enables: [true] });
  expect(await enableAndRetry(true)).toEqual({ runs: 1, enables: [true] });
});

/** Mount the task page, click its switch off with a save that resolves `saved`, return the switch. */
async function pageSwitchOff(saved: boolean) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(TaskPage, {
        taskId: "digest",
        refreshKey: 0,
        onBack: noop,
        actions: {
          onRunNow: noop,
          onRunList: noop,
          onEdit: noop,
          onDuplicate: noop,
          onDelete: noop,
          onSetEnabled: async () => saved,
          onOpenRun: noop,
          onSeeRuns: noop,
        },
      }),
    ),
  );
  const sw = () => container.querySelector<HTMLButtonElement>('button[role="switch"]');
  expect(sw()?.getAttribute("aria-checked")).toBe("true");
  await act(async () => sw()?.click());
  const after = sw()?.getAttribute("aria-checked");
  await act(async () => root.unmount());
  return after;
}

test("the task page's switch moves only when the save landed", async () => {
  expect(await pageSwitchOff(false)).toBe("true");
  expect(await pageSwitchOff(true)).toBe("false");
});
