// ---------------------------------------------------------------------------
// The sidebar's workspace list after a write, and the collapsed switcher with
// nothing focused.
//
// Pins:
//   1. `refreshWorkspaces` replaces the list with bootstrap's, so a workspace
//      created in settings reaches the switcher without a reload, and swaps
//      the focused entry for its fresh copy; a focused workspace no longer in
//      the list drops focus.
//   2. Collapsed with no focused workspace, the trigger still
//      draws an icon instead of an empty button.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { BootstrapResponse } from "../types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = "ws_00a1b2c3d4e5f607";
const B = "ws_00f7e6d5c4b3a291";

// Bootstrap is stubbed at fetch, not by mocking the client module, which
// would outlive this file and reach every later test that imports it.
let rebootstrap: BootstrapResponse["workspaces"] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) =>
  String(input).endsWith("/v1/bootstrap")
    ? new Response(JSON.stringify({ workspaces: rebootstrap }), { status: 200 })
    : new Response("unexpected", { status: 500 })) as typeof fetch;

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter } = await import("react-router-dom");
const { WorkspaceProvider, useWorkspaceContext } = await import("../context/WorkspaceContext");
const { WorkspaceSwitcher } = await import("../components/shell/WorkspaceSwitcher");

function bootstrapWs(id: string, name: string) {
  return {
    id,
    name,
    role: "admin" as const,
    memberCount: 1,
    connectorCount: 0,
    mcpUrl: `https://nb.example.test/mcp/${id}`,
    unread: 0,
  };
}

const info = (id: string, name: string) => ({ id, name, memberCount: 1, connectorCount: 0 });

let ctx: ReturnType<typeof useWorkspaceContext>;
function Probe() {
  ctx = useWorkspaceContext();
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

async function mount(
  workspaces: ReturnType<typeof info>[],
  initialActiveId?: string,
  children: React.ReactNode = null,
): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <WorkspaceProvider initialWorkspaces={workspaces} initialActiveId={initialActiveId}>
          <Probe />
          {children}
        </WorkspaceProvider>
      </MemoryRouter>,
    );
  });
}

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("refreshWorkspaces", () => {
  test("replaces the list from bootstrap and refreshes the focused entry", async () => {
    await mount([info(A, "Alpha")], A);
    rebootstrap = [bootstrapWs(A, "Alpha renamed"), bootstrapWs(B, "Beta")];

    await act(async () => ctx.refreshWorkspaces());

    expect(ctx.workspaces.map((w) => w.id)).toEqual([A, B]);
    expect(ctx.activeWorkspace?.id).toBe(A);
    expect(ctx.activeWorkspace?.name).toBe("Alpha renamed");
  });

  test("drops focus when the focused workspace is gone from the list", async () => {
    await mount([info(A, "Alpha"), info(B, "Beta")], A);
    rebootstrap = [bootstrapWs(B, "Beta")];

    await act(async () => ctx.refreshWorkspaces());

    expect(ctx.workspaces.map((w) => w.id)).toEqual([B]);
    expect(ctx.activeWorkspace).toBeNull();
  });

  test("leaves focus empty when nothing was focused", async () => {
    await mount([info(A, "Alpha")]);
    rebootstrap = [bootstrapWs(A, "Alpha"), bootstrapWs(B, "Beta")];

    await act(async () => ctx.refreshWorkspaces());

    expect(ctx.workspaces).toHaveLength(2);
    expect(ctx.activeWorkspace).toBeNull();
  });
});

describe("collapsed switcher", () => {
  test("draws an icon when no workspace is focused", async () => {
    await mount([info(A, "Alpha")], undefined, <WorkspaceSwitcher collapsed />);
    const trigger = container.querySelector('[data-testid="workspace-switcher-trigger"]');
    expect(trigger?.querySelector("svg")).not.toBeNull();
    expect(trigger?.querySelector('[data-testid="workspace-avatar"]')).toBeNull();
  });

  test("draws the focused workspace's glyph", async () => {
    await mount([info(A, "Alpha")], A, <WorkspaceSwitcher collapsed />);
    const trigger = container.querySelector('[data-testid="workspace-switcher-trigger"]');
    expect(trigger?.querySelector('[data-testid="workspace-avatar"]')).not.toBeNull();
  });
});
