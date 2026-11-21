/**
 * The test run's input follows the draft: a draft that takes no input runs
 * with none, whatever the input form last reported before it went away. The
 * editor mounts here against stub tools.
 */
import { beforeAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type * as ReactDOMClient from "react-dom/client";
import type { TaskDetail } from "../types.ts";
import type * as EditorModule from "./TaskEditor.tsx";

let editor: typeof EditorModule;
let createRoot: typeof ReactDOMClient.createRoot;

/** A task whose every run needs a company. */
const DETAIL: TaskDetail = {
  id: "brief",
  name: "Brief",
  prompt: "Write a brief on the company.",
  scheduleHuman: "Manual only",
  timezone: "UTC",
  enabled: true,
  source: "user",
  runCount: 0,
  consecutiveErrors: 0,
  lastRunStatus: null,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  inputSchema: {
    type: "object",
    properties: { company: { type: "string" } },
    required: ["company"],
  },
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
      const data = name === "status" ? { task: DETAIL } : { servers: [] };
      tool = { call: async () => ({ data, isError: false, content: [] }) };
      tools.set(name, tool);
    }
    return tool;
  };
  mock.module("@nimblebrain/synapse/react", () => ({
    ...real,
    useCallTool: (name: string) => ({ ...toolOf(name), isPending: false, error: null, data: null }),
  }));
  editor = await import("./TaskEditor.tsx");
  ({ createRoot } = await import("react-dom/client"));
});

test("removing the last required input field lets the draft be tried", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(editor.TaskEditor, { taskId: "brief", onSaved: () => {}, onCancel: () => {} }),
    ),
  );
  const tryButton = () =>
    [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.startsWith("Try it"),
    ) as HTMLButtonElement;
  // The company is required and empty: there is nothing to try yet.
  expect(tryButton().disabled).toBe(true);

  const remove = container.querySelector(
    'button[aria-label="Remove field company"]',
  ) as HTMLButtonElement;
  await act(async () => remove.click());
  expect(tryButton().disabled).toBe(false);
  await act(async () => root.unmount());
  container.remove();
});
