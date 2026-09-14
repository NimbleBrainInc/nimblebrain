// ---------------------------------------------------------------------------
// OrgArchivesTab — what the page must never get wrong.
//
// Pins:
//   1. An archive with no readable workspace.json is shown as Unknown, not
//      dropped. Those are the rows nothing else describes.
//   2. Purge is behind a confirm that states the size and that it cannot be
//      undone, and a declined confirm sends nothing.
//   3. Purge names exactly one archive, by its directory name.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

let calls: ToolCall[] = [];

const ARCHIVES = [
  {
    name: "ws_0123456789abcdef",
    workspaceId: "ws_0123456789abcdef",
    workspaceName: "Research",
    sizeBytes: 2048,
    archivedAt: "2026-01-02T03:04:05.000Z",
  },
  {
    name: "ws_orphan-1",
    workspaceId: null,
    workspaceName: null,
    sizeBytes: 10,
    archivedAt: "2026-01-01T00:00:00.000Z",
  },
];

mock.module("../api/client", () => ({
  ...realClient,
  callTool: mock(async (_source: string, tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (args.action === "purge_archive") {
      return {
        content: [{ type: "text", text: "Purged." }],
        structuredContent: { purged: true, name: args.archive, sizeBytes: 2048 },
      };
    }
    return {
      content: [{ type: "text", text: "2 archive(s)." }],
      structuredContent: { archives: ARCHIVES },
    };
  }),
}));

let confirmReturn = true;
const windowConfirm = mock((_msg?: string) => confirmReturn);
Object.defineProperty(window, "confirm", { configurable: true, value: windowConfirm });

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { OrgArchivesTab, formatArchiveSize } = await import("../pages/settings/OrgArchivesTab");

let unmount: (() => void) | null = null;

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(OrgArchivesTab)));
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

async function clickPurge(container: HTMLElement, name: string): Promise<void> {
  const button = container.querySelector(`button[title="Purge ${name}"]`);
  expect(button).not.toBeNull();
  await act(async () => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  unmount?.();
  unmount = null;
  calls = [];
  confirmReturn = true;
  windowConfirm.mockClear();
});

describe("OrgArchivesTab", () => {
  test("lists every archive, rendering missing identity as Unknown", async () => {
    const container = await mount();

    expect(calls[0]?.args).toEqual({ action: "list_archives" });
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Research");
    expect(rows[1]?.textContent).toContain("ws_orphan-1");
    expect(rows[1]?.textContent).toContain("Unknown");
  });

  test("purge confirms with the size and irreversibility, then names one archive", async () => {
    const container = await mount();

    await clickPurge(container, "ws_0123456789abcdef");

    const message = windowConfirm.mock.calls[0]?.[0] ?? "";
    expect(message).toContain(formatArchiveSize(2048));
    expect(message).toContain("cannot be undone");
    expect(calls.filter((c) => c.args.action === "purge_archive")).toEqual([
      {
        tool: "manage_workspaces",
        args: { action: "purge_archive", archive: "ws_0123456789abcdef" },
      },
    ]);
  });

  test("a declined confirm purges nothing", async () => {
    confirmReturn = false;
    const container = await mount();

    await clickPurge(container, "ws_orphan-1");

    expect(windowConfirm).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.args.action === "purge_archive")).toBe(false);
  });
});

describe("formatArchiveSize", () => {
  test("scales through the units", () => {
    expect(formatArchiveSize(0)).toBe("0 B");
    expect(formatArchiveSize(2048)).toBe("2.0 KB");
    expect(formatArchiveSize(5 * 1024 ** 3)).toBe("5.0 GB");
  });
});
