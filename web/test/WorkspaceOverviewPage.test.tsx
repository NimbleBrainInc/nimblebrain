// ---------------------------------------------------------------------------
// WorkspaceOverviewPage — app grid is a three-state surface
//
// The bug this pins: the grid used to render "No apps installed" whenever
// `forSlot` returned [] — which also happens while the shell hasn't caught up
// to this workspace (deep-link / switch window). Loading was conflated with
// empty, so a workspace that DOES have apps flashed a false-empty dashboard.
//
// Readiness is `shell.shellWorkspaceId === <this page's workspace id>`. The
// three states:
//   not-ready  → a stable spacer    (never the empty card; no pulsing skeleton)
//   ready+empty → "No apps installed"
//   ready+populated → the app grid
//
// Briefing is independent (its own async timeline) — callTool is stubbed to a
// never-resolving promise so it sits in its skeleton and doesn't interfere.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";
import type { PlacementEntry } from "../src/types";
import { realClient } from "./setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub only `callTool` so the briefing fetch hangs in its skeleton (its own
// async timeline — not what this file tests). Spread the preload's real-module
// snapshot (see web/test/setup.ts) so every other export stays intact: a bare
// `{ callTool }` mock leaks across files in the same test process and strips
// functions the client/bridge suites depend on (getAuthToken,
// getActiveWorkspaceId, …). The snapshot predates every mock.module, so it
// can't itself be an incomplete stub the way `import * as` from the registry
// could. WorkspaceContext skips its list call when given bootstrap data, so the
// real setActiveWorkspaceId it calls is harmless — sibling suites reset client
// state in their own beforeEach.
let callToolImpl: () => Promise<unknown> = () => new Promise(() => {});
mock.module("../src/api/client", () => ({
  ...realClient,
  callTool: () => callToolImpl(),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");
const { WorkspaceOverviewPage } = await import("../src/pages/WorkspaceOverviewPage");
const { WorkspaceProvider } = await import("../src/context/WorkspaceContext");
const { ShellProvider } = await import("../src/context/ShellContext");
const { toSlug } = await import("../src/lib/workspace-slug");
const { WorkspaceAppIconsContext } = await import("../src/context/WorkspaceAppIconsContext");
const { useLocation } = await import("react-router-dom");
type InstalledConnector = import("../src/api/client").InstalledConnector;

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  callToolImpl = () => new Promise(() => {});
});

async function mount(element: React.ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

function findByTestId(container: HTMLElement, testid: string): HTMLElement | null {
  for (const el of Array.from(container.getElementsByTagName("*"))) {
    if (el.getAttribute("data-testid") === testid) return el as HTMLElement;
  }
  return null;
}

function findAllByTestId(container: HTMLElement, testid: string): HTMLElement[] {
  return Array.from(container.getElementsByTagName("*")).filter(
    (el) => el.getAttribute("data-testid") === testid,
  ) as HTMLElement[];
}

const WS: WorkspaceInfo = {
  id: "ws_acme",
  name: "Acme",
  memberCount: 2,
  connectors: [],
  userRole: "admin",
};

function appPlacement(over: Partial<PlacementEntry>): PlacementEntry {
  return {
    serverName: "crm",
    slot: "sidebar.apps",
    resourceUri: "ui://crm/main",
    priority: 10,
    label: "CRM",
    route: "crm",
    ...over,
  };
}

// `shellWorkspaceId` is the lever: equal to WS.id → ready; anything else → not.
function harness(shellWorkspaceId: string | undefined, placements: PlacementEntry[]) {
  const shellValue = {
    forSlot: (slot: string): PlacementEntry[] =>
      placements.filter((p) => p.slot === slot || p.slot.startsWith(`${slot}.`)),
    mainRoutes: (): PlacementEntry[] => [],
    shellWorkspaceId,
  };
  return (
    <MemoryRouter initialEntries={[`/w/${toSlug(WS.id)}`]}>
      <ShellProvider value={shellValue}>
        <WorkspaceProvider initialWorkspaces={[WS]} initialActiveId={WS.id}>
          <Routes>
            <Route path="/w/:slug" element={<WorkspaceOverviewPage />} />
          </Routes>
        </WorkspaceProvider>
      </ShellProvider>
    </MemoryRouter>
  );
}

describe("WorkspaceOverviewPage — app grid three states", () => {
  test("not ready (shell lags this workspace) → a stable spacer, never the empty card", async () => {
    // Shell still reflects a different workspace (the switch/deep-link window).
    mounted = await mount(harness("ws_other", [appPlacement({})]));

    // A held space, not a pulsing skeleton — the page stays mounted across a
    // switch, so the apps section just holds its place until the shell resolves.
    expect(findByTestId(mounted.container, "workspace-overview-apps-pending")).not.toBeNull();
    // The false-empty regression: must NOT show "No apps installed" while loading.
    expect(findByTestId(mounted.container, "workspace-overview-empty")).toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-app-grid")).toBeNull();
    // Header omits the (unknown) app count, but still shows members.
    const breadcrumb = findByTestId(mounted.container, "workspace-overview-page");
    expect(breadcrumb?.textContent).toContain("2 members");
    expect(breadcrumb?.textContent).not.toContain("apps installed");
  });

  test("ready + empty → the empty card, no pending spacer", async () => {
    mounted = await mount(harness(WS.id, []));

    expect(findByTestId(mounted.container, "workspace-overview-empty")).not.toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-apps-pending")).toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-app-grid")).toBeNull();
  });

  test("ready + populated → the grid with cards, header shows the count", async () => {
    mounted = await mount(
      harness(WS.id, [
        appPlacement({ route: "crm", label: "CRM", resourceUri: "ui://crm/main" }),
        appPlacement({ route: "todo", label: "Todo", resourceUri: "ui://todo/main" }),
      ]),
    );

    expect(findByTestId(mounted.container, "workspace-overview-app-grid")).not.toBeNull();
    expect(findAllByTestId(mounted.container, "workspace-overview-app-card")).toHaveLength(2);
    expect(findByTestId(mounted.container, "workspace-overview-apps-pending")).toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-empty")).toBeNull();

    const page = findByTestId(mounted.container, "workspace-overview-page");
    expect(page?.textContent).toContain("2 apps installed, 2 members");
  });
});

describe("WorkspaceOverviewPage — briefing", () => {
  function Where() {
    return <div data-testid="location">{useLocation().pathname}</div>;
  }

  test("a connector needing sign-in opens its connector page", async () => {
    callToolImpl = () =>
      Promise.resolve({ isError: false, structuredContent: { items: [], generated_at: "" } });
    const gmail: InstalledConnector = {
      serverName: "gmail",
      connectorName: "gmail",
      version: "1.0.0",
      state: "pending_auth",
      scope: "workspace",
      interactive: false,
      toolCount: 0,
      status: "needs_auth",
    };
    const slug = toSlug(WS.id);
    mounted = await mount(
      <WorkspaceAppIconsContext.Provider
        value={{ iconFor: () => undefined, connectors: { workspaceId: WS.id, installed: [gmail] } }}
      >
        <MemoryRouter initialEntries={[`/w/${slug}`]}>
          <WorkspaceProvider initialWorkspaces={[WS]} initialActiveId={WS.id}>
            <Routes>
              <Route path="/w/:slug" element={<WorkspaceOverviewPage />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </WorkspaceProvider>
        </MemoryRouter>
      </WorkspaceAppIconsContext.Provider>,
    );

    const row = findByTestId(mounted.container, "briefing-connector-status");
    expect(row?.textContent).toBe("Critical: Sign-in required · gmail");
    expect(findByTestId(mounted.container, "workspace-briefing-empty")).toBeNull();
    await act(async () => {
      row?.getElementsByTagName("button")[0]?.click();
    });
    expect(findByTestId(mounted.container, "location")?.textContent).toBe(
      `/w/${slug}/settings/connectors/gmail`,
    );
  });

  test("renders nothing until the connectors list names this workspace", async () => {
    callToolImpl = () =>
      Promise.resolve({ isError: false, structuredContent: { items: [], generated_at: "" } });
    mounted = await mount(
      <WorkspaceAppIconsContext.Provider
        value={{ iconFor: () => undefined, connectors: { workspaceId: "ws_other", installed: [] } }}
      >
        <MemoryRouter initialEntries={[`/w/${toSlug(WS.id)}`]}>
          <WorkspaceProvider initialWorkspaces={[WS]} initialActiveId={WS.id}>
            <Routes>
              <Route path="/w/:slug" element={<WorkspaceOverviewPage />} />
            </Routes>
          </WorkspaceProvider>
        </MemoryRouter>
      </WorkspaceAppIconsContext.Provider>,
    );
    expect(findByTestId(mounted.container, "workspace-briefing")).toBeNull();
  });
});
