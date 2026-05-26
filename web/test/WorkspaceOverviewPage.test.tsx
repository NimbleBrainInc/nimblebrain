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
//   not-ready  → skeleton           (never the empty card)
//   ready+empty → "No apps installed"
//   ready+populated → the app grid
//
// Briefing is independent (its own async timeline) — callTool is stubbed to a
// never-resolving promise so it sits in its skeleton and doesn't interfere.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import * as actualClient from "../src/api/client";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";
import type { PlacementEntry } from "../src/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Stub only `callTool` so the briefing fetch hangs in its skeleton (its own
// async timeline — not what this file tests). Spread the real module so every
// other export stays intact: a bare `{ callTool }` mock leaks across files in
// the same test process and strips functions the client/bridge suites depend
// on (getAuthToken, getActiveWorkspaceId, …). WorkspaceContext skips its list
// call when given bootstrap data, so the real setActiveWorkspaceId it calls is
// harmless — sibling suites reset client state in their own beforeEach.
mock.module("../src/api/client", () => ({
  ...actualClient,
  callTool: () => new Promise(() => {}),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");
const { WorkspaceOverviewPage } = await import("../src/pages/WorkspaceOverviewPage");
const { WorkspaceProvider } = await import("../src/context/WorkspaceContext");
const { ShellProvider } = await import("../src/context/ShellContext");
const { toSlug } = await import("../src/lib/workspace-slug");

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
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
  bundles: [],
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
  test("not ready (shell lags this workspace) → skeleton, never the empty card", async () => {
    // Shell still reflects a different workspace (the switch/deep-link window).
    mounted = await mount(harness("ws_other", [appPlacement({})]));

    expect(findByTestId(mounted.container, "workspace-overview-apps-skeleton")).not.toBeNull();
    // The false-empty regression: must NOT show "No apps installed" while loading.
    expect(findByTestId(mounted.container, "workspace-overview-empty")).toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-app-grid")).toBeNull();
    // Header omits the (unknown) app count, but still shows members.
    const breadcrumb = findByTestId(mounted.container, "workspace-overview-page");
    expect(breadcrumb?.textContent).toContain("2 members");
    expect(breadcrumb?.textContent).not.toContain("apps installed");
  });

  test("ready + empty → the empty card, no skeleton", async () => {
    mounted = await mount(harness(WS.id, []));

    expect(findByTestId(mounted.container, "workspace-overview-empty")).not.toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-apps-skeleton")).toBeNull();
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
    expect(findByTestId(mounted.container, "workspace-overview-apps-skeleton")).toBeNull();
    expect(findByTestId(mounted.container, "workspace-overview-empty")).toBeNull();

    const page = findByTestId(mounted.container, "workspace-overview-page");
    expect(page?.textContent).toContain("2 apps installed, 2 members");
  });
});
