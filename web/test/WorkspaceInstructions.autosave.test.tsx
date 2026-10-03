/**
 * The workspace instructions save when the editor loses focus.
 *
 * Not on a pause in typing — a half-written instruction would reach every
 * conversation in the workspace — and every save names the workspace it was
 * written in, so one that runs after the reader has switched still lands there.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "./setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

const writes: Array<{ args: Record<string, unknown>; opts: unknown }> = [];
let refusal: string | null = null;

mock.module("../src/api/client", () => ({
  ...realClient,
  readResource: async () => ({ contents: [{ uri: "instructions://workspace", text: "old" }] }),
  callTool: async (
    _server: string,
    tool: string,
    args: Record<string, unknown>,
    opts?: { workspaceId?: string },
  ) => {
    if (tool === "write_instructions") writes.push({ args, opts });
    if (refusal) return { content: [{ type: "text", text: refusal }], isError: true };
    return { structuredContent: {}, isError: false };
  },
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { NoticeProvider, NoticeViewport } = await import("../src/components/notices");
const { WorkspaceInstructions, useWorkspaceInstructions } = await import(
  "../src/pages/settings/components/WorkspaceInstructions"
);

function Harness({ canEdit }: { canEdit: boolean }) {
  const instructions = useWorkspaceInstructions("ws_a");
  return React.createElement(WorkspaceInstructions, { wsId: "ws_a", canEdit, instructions });
}

let unmount: (() => void) | null = null;
afterEach(async () => {
  await act(async () => unmount?.());
  unmount = null;
  writes.length = 0;
  refusal = null;
});

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => await Promise.resolve());
}

async function mount(canEdit = true): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        NoticeProvider,
        null,
        React.createElement(NoticeViewport),
        React.createElement(Harness, { canEdit }),
      ),
    );
  });
  await flush();
  unmount = () => {
    root.unmount();
    container.remove();
  };
  return container;
}

const win = () => (globalThis as unknown as { window: Window & typeof globalThis }).window;
const editor = (c: HTMLElement) => c.querySelector<HTMLTextAreaElement>("textarea")!;

async function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(win().HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new (win().Event)("input", { bubbles: true }));
  });
}

async function leave(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new (win().FocusEvent)("focusout", { bubbles: true }));
  });
  await flush();
}

describe("the workspace instructions editor", () => {
  test("loads the stored instructions", async () => {
    const c = await mount();
    expect(editor(c).value).toBe("old");
  });

  test("saves when the editor loses focus, naming its workspace", async () => {
    const c = await mount();
    await type(editor(c), "new");
    expect(writes).toEqual([]);
    expect(c.textContent).toContain("Unsaved");

    await leave(editor(c));
    expect(writes).toEqual([{ args: { body: "new" }, opts: { workspaceId: "ws_a" } }]);
    expect(document.body.querySelector("[data-testid='notice']")?.textContent).toContain(
      "Workspace instructions updated",
    );
  });

  test("Enter is a newline, not a save", async () => {
    const c = await mount();
    await type(editor(c), "line one");
    await act(async () => {
      editor(c).dispatchEvent(new (win().KeyboardEvent)("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(writes).toEqual([]);
  });

  test("refuses text over the limit on the field, without sending it", async () => {
    const c = await mount();
    const long = "x".repeat(8 * 1024 + 1);
    await type(editor(c), long);
    await leave(editor(c));
    expect(writes).toEqual([]);
    expect(c.textContent).toContain("limited to 8,192 characters");
    expect(editor(c).value).toBe(long);
  });

  test("shows the server's refusal on the field", async () => {
    refusal = JSON.stringify({ error: "Only workspace admins can edit instructions." });
    const c = await mount();
    await type(editor(c), "new");
    await leave(editor(c));
    expect(c.textContent).toContain("Only workspace admins can edit instructions.");
    expect(c.textContent).toContain("Not saved");
  });

  test("is read-only for someone who cannot edit", async () => {
    const c = await mount(false);
    expect(editor(c).disabled).toBe(true);
    expect(c.textContent).toContain("Only workspace admins can edit these instructions.");
  });
});
