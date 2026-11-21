/**
 * A switch click on the board saves one task. The panel mounts here against
 * stub tools: a save that returns the task puts it on its row with no further
 * read, a save that returns none reloads the board, and a save the tool refuses
 * leaves the switch as it was and says why.
 */
import { beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type * as ReactDOMClient from "react-dom/client";
import type { TaskSummary } from "../types.ts";
import type * as TasksUIModule from "./TasksUI.tsx";

let TasksUI: typeof TasksUIModule.TasksUI;
let createRoot: typeof ReactDOMClient.createRoot;
/** How often each tool was called, and what `tasks__update` answers next. */
let calls: Record<string, number> = {};
let updateAnswer: { data: unknown; isError: boolean; content: unknown[] };

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
  nextRunAt: "2026-11-02T17:20:00.000Z",
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
          if (name === "update") return updateAnswer;
          const data = name === "list" ? { tasks: [TASK] } : {};
          return { data, isError: false, content: [] };
        },
      };
      tools.set(name, tool);
    }
    return tool;
  };
  const app = { hostCapabilities: {} };
  mock.module("@nimblebrain/synapse/react", () => ({
    ...real,
    useCallTool: (name: string) => ({ ...toolOf(name), isPending: false, error: null, data: null }),
    useApp: () => app,
    useDataSync: () => {},
    useSendMessage: () => () => {},
    useTrail: () => false,
  }));
  ({ TasksUI } = await import("./TasksUI.tsx"));
  ({ createRoot } = await import("react-dom/client"));
});

beforeEach(() => {
  calls = {};
});

/** Mount the panel, click the task's switch off, and return the switch after the save settles. */
async function clickOff() {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(TasksUI)));
  const before = { ...calls };
  const sw = () => container.querySelector<HTMLButtonElement>(".mini-switch");
  expect(sw()?.getAttribute("aria-checked")).toBe("true");
  await act(async () => sw()?.click());
  const after = sw()?.getAttribute("aria-checked");
  const text = container.textContent ?? "";
  await act(async () => root.unmount());
  return { before, after, text };
}

test("a save that returns the task updates its row with no further read", async () => {
  updateAnswer = {
    data: { task: { id: "digest", enabled: false, disabledAt: "2026-11-01T10:00:00.000Z" } },
    isError: false,
    content: [],
  };
  const { before, after } = await clickOff();
  expect(after).toBe("false");
  expect(calls.update).toBe(1);
  expect(calls.list).toBe(before.list);
  expect(calls.stats).toBe(before.stats);
  expect(calls.upcoming).toBe(before.upcoming);
});

test("a save that returns no task reloads the board", async () => {
  updateAnswer = { data: {}, isError: false, content: [] };
  const { before } = await clickOff();
  expect(calls.update).toBe(1);
  expect(calls.list).toBe((before.list ?? 0) + 1);
  expect(calls.stats).toBe((before.stats ?? 0) + 1);
});

test("a save the tool refuses keeps the switch on and says why", async () => {
  updateAnswer = {
    data: null,
    isError: true,
    content: [{ type: "text", text: "Task is locked." }],
  };
  const { before, after, text } = await clickOff();
  expect(calls.update).toBe(1);
  expect(after).toBe("true");
  expect(text).toContain("Task is locked.");
  expect(calls.list).toBe(before.list);
});
