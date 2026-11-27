// ---------------------------------------------------------------------------
// OrgDeletedWorkspacesTab — what the page must never get wrong.
//
// Pins:
//   1. Every deleted workspace is listed with its purge time.
//   2. Restore names exactly one workspace, and is off once its purge began.
//   3. Purge is behind a confirm that says it cannot be undone, and a declined
//      confirm sends nothing.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

let calls: ToolCall[] = [];

const DELETED = [
  {
    workspaceId: "ws_0123456789abcdef",
    workspaceName: "Research",
    memberCount: 2,
    deletedAt: "2026-01-02T03:04:05.000Z",
    deletedBy: "usr_a",
    purgeAt: "2026-02-01T03:04:05.000Z",
    restorable: true,
  },
  {
    workspaceId: "ws_0057ae5b54fe4216",
    workspaceName: null,
    memberCount: 0,
    deletedAt: "2026-01-01T00:00:00.000Z",
    deletedBy: null,
    purgeAt: "2026-01-01T00:00:00.000Z",
    restorable: false,
  },
];

mock.module("../api/client", () => ({
  ...realClient,
  callToolWithoutWorkspace: mock(
    async (_source: string, tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args });
      if (args.action === "list_deleted") {
        return {
          content: [{ type: "text", text: "2 deleted workspace(s)." }],
          structuredContent: { deleted: DELETED },
        };
      }
      return { content: [{ type: "text", text: "Done." }], structuredContent: {} };
    },
  ),
}));

let confirmReturn = true;
const windowConfirm = mock((_msg?: string) => confirmReturn);
Object.defineProperty(window, "confirm", { configurable: true, value: windowConfirm });

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { OrgDeletedWorkspacesTab } = await import("../pages/settings/OrgDeletedWorkspacesTab");

let unmount: (() => void) | null = null;

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(MemoryRouter, null, React.createElement(OrgDeletedWorkspacesTab)),
    );
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  unmount = () => {
    root.unmount();
    container.remove();
  };
  return container;
}

function button(container: HTMLElement, title: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  expect(found).not.toBeNull();
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const sent = (action: string) => calls.filter((c) => c.args.action === action);

afterEach(() => {
  unmount?.();
  unmount = null;
  calls = [];
  confirmReturn = true;
  windowConfirm.mockClear();
});

describe("OrgDeletedWorkspacesTab", () => {
  test("lists every deleted workspace, an unnamed one as Unknown", async () => {
    const container = await mount();

    expect(calls[0]?.args).toEqual({ action: "list_deleted" });
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Research");
    expect(rows[1]?.textContent).toContain("Unknown");
    expect(rows[1]?.textContent).toContain("Purging");
  });

  test("restore names one workspace, and is off once its purge began", async () => {
    const container = await mount();

    expect(button(container, "Restore ws_0057ae5b54fe4216").disabled).toBe(true);
    await click(button(container, "Restore ws_0123456789abcdef"));

    expect(windowConfirm).not.toHaveBeenCalled();
    expect(sent("restore")).toEqual([
      {
        tool: "manage_workspaces",
        args: { action: "restore", workspaceId: "ws_0123456789abcdef" },
      },
    ]);
  });

  test("purge confirms that it cannot be undone, then names one workspace", async () => {
    const container = await mount();

    await click(button(container, "Purge ws_0123456789abcdef"));

    expect(windowConfirm.mock.calls[0]?.[0] ?? "").toContain("cannot be undone");
    expect(sent("purge")).toEqual([
      { tool: "manage_workspaces", args: { action: "purge", workspaceId: "ws_0123456789abcdef" } },
    ]);
  });

  test("a declined confirm purges nothing", async () => {
    confirmReturn = false;
    const container = await mount();

    await click(button(container, "Purge ws_0057ae5b54fe4216"));

    expect(windowConfirm).toHaveBeenCalledTimes(1);
    expect(sent("purge")).toEqual([]);
  });
});
