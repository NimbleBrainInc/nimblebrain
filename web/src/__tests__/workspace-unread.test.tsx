// ---------------------------------------------------------------------------
// Unread dots for other workspaces — WorkspaceUnreadProvider + the switcher.
//
// Pins:
//   1. Counts start from bootstrap, and a `notification.created` or
//      `notification.read` frame for any workspace sets that workspace's
//      count from the frame, with no read.
//   2. A reconnect re-reads bootstrap, since the stream does not replay.
//   3. The switcher marks each workspace with unread on its row, and marks
//      the trigger only when the unread is in a workspace other than this one:
//      on the chevrons, not beside the focused name, and naming that workspace.
//
// Drives the real events-client singleton through `setConnectorForTest`, as
// notifications-provider.test.tsx does, rather than mocking `useEvents`.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import { __internal__ } from "../api/events-client";
import type { ConnectEventsOptions, EventConnection } from "../api/sse";
import type { BootstrapResponse, WorkspaceStreamEvents } from "../types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOME = "ws_00a1b2c3d4e5f607";
const OTHER = "ws_00f7e6d5c4b3a291";

let rebootstrap: BootstrapResponse["workspaces"] = [];

mock.module("../api/client", () => ({
  ...realClient,
  tryBootstrap: mock(async () => ({ workspaces: rebootstrap }) as unknown as BootstrapResponse),
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { WorkspaceUnreadProvider, useWorkspaceUnread } = await import(
  "../context/WorkspaceUnreadContext"
);
const { WorkspaceSwitcher, unreadIn } = await import("../components/shell/WorkspaceSwitcher");

class FakeConnection implements EventConnection {
  close(): void {}
}
let lastOptions: ConnectEventsOptions | null = null;

function bootstrapWs(id: string, name: string, unread: number) {
  return {
    id,
    name,
    role: "admin" as const,
    memberCount: 1,
    connectorCount: 0,
    mcpUrl: `https://nb.example.test/mcp/${id}`,
    unread,
  };
}

const seen: Record<string, number> = {};
function Probe() {
  const { unreadFor } = useWorkspaceUnread();
  seen[HOME] = unreadFor(HOME);
  seen[OTHER] = unreadFor(OTHER);
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

async function mount(workspaces: BootstrapResponse["workspaces"]): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  const infos = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
    memberCount: w.memberCount,
    connectorCount: w.connectorCount,
    userRole: w.role,
  }));
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/w/00a1b2c3d4e5f607/"]}>
        <WorkspaceProvider initialWorkspaces={infos} initialActiveId={HOME}>
          <WorkspaceUnreadProvider workspaces={workspaces}>
            <Probe />
            <WorkspaceSwitcher />
          </WorkspaceUnreadProvider>
        </WorkspaceProvider>
      </MemoryRouter>,
    );
  });
}

function frame<K extends keyof WorkspaceStreamEvents>(
  type: K,
  data: WorkspaceStreamEvents[K],
): void {
  act(() => {
    lastOptions?.onEvent(type, data);
  });
}

const trigger = () =>
  container.querySelector<HTMLElement>('[data-testid="workspace-switcher-trigger"]');

beforeEach(() => {
  rebootstrap = [];
  lastOptions = null;
  __internal__.resetForTest();
  __internal__.setConnectorForTest((options: ConnectEventsOptions) => {
    lastOptions = options;
    return new FakeConnection();
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __internal__.resetForTest();
  __internal__.setConnectorForTest(null);
});

describe("WorkspaceUnreadProvider", () => {
  test("starts from bootstrap and follows the frames for every workspace", async () => {
    await mount([bootstrapWs(HOME, "Home", 0), bootstrapWs(OTHER, "Other", 2)]);
    expect(seen).toEqual({ [HOME]: 0, [OTHER]: 2 });

    frame("notification.created", {
      workspaceId: OTHER,
      id: "acme:e3",
      seq: 3,
      source: "acme",
      name: "domain.active",
      level: "info",
      title: "t",
      receivedAt: "2026-09-01T18:43:00.000Z",
      unread: 3,
    });
    expect(seen[OTHER]).toBe(3);

    frame("notification.read", { workspaceId: OTHER, ids: ["acme:e1"], unread: 0 });
    expect(seen[OTHER]).toBe(0);
  });

  test("a reconnect re-reads bootstrap", async () => {
    await mount([bootstrapWs(HOME, "Home", 0), bootstrapWs(OTHER, "Other", 0)]);
    rebootstrap = [bootstrapWs(HOME, "Home", 1), bootstrapWs(OTHER, "Other", 4)];
    await act(async () => {
      lastOptions?.onReconnect?.();
      await Promise.resolve();
    });
    expect(seen).toEqual({ [HOME]: 1, [OTHER]: 4 });
  });
});

describe("the switcher", () => {
  test("marks the trigger when another workspace has unread", async () => {
    await mount([bootstrapWs(HOME, "Home", 0), bootstrapWs(OTHER, "Other", 2)]);
    const dot = trigger()?.querySelector('[data-testid="unread-dot"]');
    expect(dot).not.toBeNull();
    // On the chevrons, not a sibling of the focused workspace's name.
    expect(dot?.parentElement).not.toBe(trigger());
    expect(dot?.parentElement?.querySelector("svg")).not.toBeNull();
    expect(trigger()?.getAttribute("aria-label")).toContain("Unread in Other");
  });

  test("names one workspace, then counts the rest", () => {
    expect(unreadIn([])).toBe("");
    expect(unreadIn(["Acme"])).toBe("Unread in Acme");
    expect(unreadIn(["Acme", "Beta"])).toBe("Unread in Acme and 1 other");
    expect(unreadIn(["Acme", "Beta", "Gamma"])).toBe("Unread in Acme and 2 others");
  });

  test("does not mark the trigger for the workspace you are already in", async () => {
    await mount([bootstrapWs(HOME, "Home", 5), bootstrapWs(OTHER, "Other", 0)]);
    expect(trigger()?.querySelector('[data-testid="unread-dot"]')).toBeNull();
  });

  test("marks each workspace with unread on its row", async () => {
    await mount([bootstrapWs(HOME, "Home", 5), bootstrapWs(OTHER, "Other", 0)]);
    await act(async () => trigger()?.click());
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="workspace-switcher-option"]'),
    );
    const dotted = rows
      .filter((row) => row.querySelector('[data-testid="unread-dot"]'))
      .map((row) => row.getAttribute("data-workspace-id"));
    expect(dotted).toEqual([HOME]);
  });
});
