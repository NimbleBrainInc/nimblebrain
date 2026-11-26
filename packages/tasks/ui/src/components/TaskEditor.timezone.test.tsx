/**
 * A schedule saved from the form is read on the clock its times were typed on:
 * an edit keeps the stored schedule's timezone (a cron always names one), and a
 * new schedule takes the viewer's. The editor mounts here against stub tools that record what a save
 * sends.
 */
import { beforeAll, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";
import type * as ReactDOMClient from "react-dom/client";
import type { TaskDetail } from "../types.ts";
import type * as EditorModule from "./TaskEditor.tsx";

let editor: typeof EditorModule;
let createRoot: typeof ReactDOMClient.createRoot;

/** A task that runs daily at 9 in Berlin. */
const DETAIL: TaskDetail = {
  id: "berlin-digest",
  name: "Berlin digest",
  prompt: "Summarize the morning's email.",
  schedule: { cron: "0 9 * * *", timezone: "Europe/Berlin" },
  scheduleHuman: "Every day at 9:00 AM Europe/Berlin",
  enabled: true,
  runCount: 0,
  consecutiveErrors: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** The task `status` returns. */
let stored: TaskDetail = DETAIL;

/** What each save sent, by tool. */
const sent: Record<string, Record<string, unknown>[]> = {};

beforeAll(async () => {
  const { window } = new JSDOM("", { url: "http://localhost" });
  Object.assign(globalThis, {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const real = await import("@nimblebrain/synapse/react");
  const tools = new Map<string, { call: (args?: Record<string, unknown>) => Promise<unknown> }>();
  const toolOf = (name: string) => {
    let tool = tools.get(name);
    if (!tool) {
      tool = {
        call: async (args?: Record<string, unknown>) => {
          if (name === "create" || name === "update") {
            sent[name] = [...(sent[name] ?? []), args ?? {}];
            return {
              data: { task: { id: "saved", name: "Saved" } },
              isError: false,
              content: [],
            };
          }
          const data = name === "status" ? { task: stored } : {};
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
  editor = await import("./TaskEditor.tsx");
  ({ createRoot } = await import("react-dom/client"));
});

/** Type into a controlled field the way a person does: set its value, then fire `input`. */
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement : window.HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new window.Event("input", { bubbles: true }));
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const b = [...container.querySelectorAll("button")].find((x) => x.textContent === text);
  if (!b) throw new Error(`no "${text}" button`);
  return b as HTMLButtonElement;
}

/** The cron schedule a save sent, as `create` / `update` take it. */
function savedSchedule(tool: "create" | "update"): Record<string, unknown> | undefined {
  const args = sent[tool]?.at(-1);
  const manifest = (args?.manifest ?? {}) as Record<string, unknown>;
  return manifest.schedule as Record<string, unknown> | undefined;
}

test("an edited schedule keeps its own timezone, and the form says which it is", async () => {
  stored = DETAIL;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(editor.TaskEditor, {
        taskId: "berlin-digest",
        onSaved: () => {},
        onCancel: () => {},
      }),
    ),
  );
  expect(container.textContent).toContain("Times are in Europe/Berlin.");

  // Move it from 9 to 10, then save.
  const daily = container.querySelector('input[type="time"]') as HTMLInputElement;
  await act(async () => type(daily, "10:00"));
  await act(async () => button(container, "Save changes").click());

  expect(savedSchedule("update")).toMatchObject({ cron: "0 10 * * *", timezone: "Europe/Berlin" });
  await act(async () => root.unmount());
});

test("a new schedule is read on the viewer's clock", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(editor.TaskEditor, { onSaved: () => {}, onCancel: () => {} })),
  );
  const prompt = container.querySelector("textarea") as HTMLTextAreaElement;
  await act(async () => type(prompt, "Summarize the morning's email."));
  await act(async () => button(container, "Save").click());

  const viewer = Intl.DateTimeFormat().resolvedOptions().timeZone;
  expect(savedSchedule("create")).toMatchObject({ cron: "0 9 * * *", timezone: viewer });
  expect(container.textContent).toContain(`Times are in ${viewer}.`);
  await act(async () => root.unmount());
});
