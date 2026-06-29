// ---------------------------------------------------------------------------
// WorkspaceNav — the workspace tree (load-bearing UI contract).
//
// Pins:
//   1. A single WORKSPACES list. Personal sorts first as "Home · Personal";
//      the rest are alphabetical. Exactly one node — the focused one — is
//      expanded (single-expand accordion = the one workspace you're walled to).
//   2. The focused workspace's subtree nests its identity views
//      (Conversations / Automations / Files) routed to `/w/<slug>/<view>`, its
//      apps routed to `/w/<slug>/app/<route>`, and a Connectors row to
//      `/w/<slug>/settings/connectors`.
//   3. Identity views are workspace-scoped routes now — the slug is the focused
//      workspace (Personal → `ws_user_u1` → slug `user_u1`).
//   4. The app quick-list caps at MAX_INLINE_APPS with a View-all overflow to
//      the workspace overview. The Connectors count comes from the shared
//      app-icons fetch.
//   5. Selecting a (non-focused) workspace fires setActiveWorkspaceId once and
//      navigates to its overview `/w/<slug>/` — Personal included (it is just
//      the workspace labelled "Home · Personal", not a detour through `/`).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockedActiveId: string | null = null;
const setActiveSpy = mock((id: string | null) => {
  if (mockedActiveId === id) return;
  mockedActiveId = id;
});

mock.module("../api/client", () => ({
  ...realClient,
  setActiveWorkspaceId: setActiveSpy,
  getActiveWorkspaceId: (): string | null => mockedActiveId,
  callTool: mock(async () => ({ structuredContent: null, content: [] })),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { ShellProvider } = await import("../context/ShellContext");
const { WorkspaceAppIconsContext } = await import("../context/WorkspaceAppIconsContext");
const { WorkspaceNav } = await import("../components/shell/WorkspaceNav");

import type { WorkspaceInfo } from "../context/WorkspaceContext";
import type { PlacementEntry } from "../types";

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
  navigationTarget(): string;
}

let mounted: Mounted | null = null;
let navTarget = "/";

function NavigationProbe() {
  const location = useLocation();
  navTarget = location.pathname;
  return null;
}

// Mirror useShell's forSlot: prefix-match `slot` + `slot.`, priority asc.
function makeForSlot(placements: PlacementEntry[]) {
  return (slot: string): PlacementEntry[] =>
    placements
      .filter((p) => p.slot === slot || p.slot.startsWith(`${slot}.`))
      .sort((a, b) => a.priority - b.priority);
}

async function mount({
  workspaces,
  activeId,
  initialPath = "/",
  placements = [],
  collapsed = false,
  connectorCount,
}: {
  workspaces: WorkspaceInfo[];
  activeId?: string;
  initialPath?: string;
  placements?: PlacementEntry[];
  collapsed?: boolean;
  connectorCount?: number;
}): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <React.StrictMode>
        <MemoryRouter initialEntries={[initialPath]}>
          <WorkspaceProvider initialWorkspaces={workspaces} initialActiveId={activeId}>
            <NavigationProbe />
            <WorkspaceAppIconsContext.Provider value={{ iconFor: () => undefined, connectorCount }}>
              <ShellProvider
                value={{
                  forSlot: makeForSlot(placements),
                  mainRoutes: () => [],
                  // The shell reflects the focused workspace; the app quick-list
                  // gates on shellWorkspaceId === focused.id.
                  shellWorkspaceId: activeId,
                }}
              >
                <Routes>
                  <Route path="*" element={<WorkspaceNav collapsed={collapsed} />} />
                </Routes>
              </ShellProvider>
            </WorkspaceAppIconsContext.Provider>
          </WorkspaceProvider>
        </MemoryRouter>
      </React.StrictMode>,
    );
  });

  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
    navigationTarget: () => navTarget,
  };
}

beforeEach(() => {
  mockedActiveId = null;
  setActiveSpy.mockClear();
  navTarget = "/";
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function ws(overrides: Partial<WorkspaceInfo> & { id: string; name: string }): WorkspaceInfo {
  return {
    id: overrides.id,
    name: overrides.name,
    bundles: [],
    memberCount: 1,
    isPersonal: overrides.isPersonal ?? false,
    userRole: overrides.userRole ?? "admin",
    ...overrides,
  };
}

function identityPlacement(serverName: string, priority: number): PlacementEntry {
  return {
    serverName,
    slot: "sidebar",
    resourceUri: `ui://${serverName}/main`,
    priority,
    label: serverName[0]!.toUpperCase() + serverName.slice(1),
    route: serverName,
  };
}

function appPlacement(serverName: string, over: Partial<PlacementEntry> = {}): PlacementEntry {
  return {
    serverName,
    slot: "sidebar.apps",
    resourceUri: `ui://${serverName}/main`,
    priority: 100,
    label: serverName,
    route: serverName,
    ...over,
  };
}

const IDENTITY_PLACEMENTS: PlacementEntry[] = [
  identityPlacement("conversations", 1),
  identityPlacement("automations", 2),
  identityPlacement("files", 3),
];

function byTestId(container: HTMLElement, testid: string): HTMLElement[] {
  return Array.from(container.getElementsByTagName("*")).filter(
    (el) => el.getAttribute("data-testid") === testid,
  ) as HTMLElement[];
}

function anchorHrefs(container: HTMLElement): string[] {
  return Array.from(container.getElementsByTagName("a")).map((a) => a.getAttribute("href") ?? "");
}

function headerById(container: HTMLElement): Record<string, HTMLElement> {
  return Object.fromEntries(
    byTestId(container, "sidebar-workspace-header").map((h) => [
      h.getAttribute("data-workspace-id"),
      h,
    ]),
  );
}

const PERSONAL = ws({ id: "ws_user_u1", name: "Personal", isPersonal: true });
const HELIX = ws({ id: "ws_helix", name: "Helix" });
const ACME = ws({ id: "ws_acme", name: "Acme" });

// ---------------------------------------------------------------------------
// (1) Ordering + single-expand
// ---------------------------------------------------------------------------

describe("WorkspaceNav — ordering + single-expand", () => {
  test("lists Personal first then alphabetical, with only the focused node expanded", async () => {
    mounted = await mount({
      workspaces: [HELIX, PERSONAL, ACME],
      activeId: "ws_user_u1", // focused on Personal
      placements: IDENTITY_PLACEMENTS,
    });

    const ids = byTestId(mounted.container, "sidebar-workspace-node").map((n) =>
      n.getAttribute("data-workspace-id"),
    );
    expect(ids).toEqual(["ws_user_u1", "ws_acme", "ws_helix"]);

    // Exactly one expanded subtree — the focused (Personal) one.
    const contents = byTestId(mounted.container, "sidebar-workspace-contents");
    expect(contents).toHaveLength(1);
    expect(contents[0]?.getAttribute("data-workspace-id")).toBe("ws_user_u1");

    const headers = headerById(mounted.container);
    expect(headers["ws_user_u1"]?.getAttribute("data-focused")).toBe("true");
    expect(headers["ws_helix"]?.getAttribute("data-focused")).toBe("false");
    expect(headers["ws_acme"]?.getAttribute("data-focused")).toBe("false");
  });
});

// ---------------------------------------------------------------------------
// (2) Focused on Personal (home)
// ---------------------------------------------------------------------------

describe("WorkspaceNav — focused on Personal (home)", () => {
  test("Personal is the home row; its identity views route under /w/user_u1/", async () => {
    mounted = await mount({
      workspaces: [PERSONAL, HELIX],
      activeId: "ws_user_u1",
      placements: IDENTITY_PLACEMENTS,
    });

    const personalHeader = headerById(mounted.container)["ws_user_u1"];
    expect(personalHeader?.getAttribute("data-is-personal")).toBe("true");
    expect(personalHeader?.textContent).toContain("Home · Personal");

    // Identity views route under the focused workspace's slug (ws_user_u1 →
    // user_u1), NOT the old top-level /conversations.
    const hrefs = anchorHrefs(mounted.container);
    expect(hrefs).toContain("/w/user_u1/conversations");
    expect(hrefs).toContain("/w/user_u1/automations");
    expect(hrefs).toContain("/w/user_u1/files");
    expect(hrefs).toContain("/w/user_u1/settings/connectors");
  });
});

// ---------------------------------------------------------------------------
// (3) Focused on a shared workspace
// ---------------------------------------------------------------------------

describe("WorkspaceNav — focused on a shared workspace", () => {
  test("the focused workspace's apps + connectors nest under it, routed into the workspace", async () => {
    mounted = await mount({
      workspaces: [PERSONAL, HELIX, ACME],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
      placements: [...IDENTITY_PLACEMENTS, appPlacement("people"), appPlacement("tasks")],
      connectorCount: 4,
    });

    // Only Helix is expanded.
    const contents = byTestId(mounted.container, "sidebar-workspace-contents");
    expect(contents).toHaveLength(1);
    expect(contents[0]?.getAttribute("data-workspace-id")).toBe("ws_helix");

    // Helix's apps nest under it, routed into the workspace.
    const appRows = byTestId(mounted.container, "sidebar-workspace-app");
    expect(appRows.map((r) => r.getAttribute("data-app-route")).sort()).toEqual([
      "people",
      "tasks",
    ]);
    const hrefs = anchorHrefs(mounted.container);
    expect(hrefs).toContain("/w/helix/app/people");
    expect(hrefs).toContain("/w/helix/conversations");
    expect(hrefs).toContain("/w/helix/settings/connectors");

    // Connectors count badge reflects the focused workspace's installed count.
    const badge = byTestId(mounted.container, "sidebar-workspace-count");
    expect(badge).toHaveLength(1);
    expect(badge[0]?.textContent).toBe("4");
  });
});

// ---------------------------------------------------------------------------
// (4) App quick-list cap + overflow
// ---------------------------------------------------------------------------

describe("WorkspaceNav — app quick-list", () => {
  test("caps apps at MAX_INLINE_APPS with a View-all overflow to the overview", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
      placements: [
        appPlacement("collateral", { priority: 10 }),
        appPlacement("salesforce", { priority: 20 }),
        appPlacement("apollo", { priority: 30 }),
        appPlacement("gong", { priority: 40 }),
        appPlacement("knowledge", { priority: 50 }),
      ],
    });

    expect(byTestId(mounted.container, "sidebar-workspace-app")).toHaveLength(4);

    const viewAll = byTestId(mounted.container, "sidebar-workspace-view-all");
    expect(viewAll).toHaveLength(1);
    expect(viewAll[0]?.textContent).toContain("View all 5 apps");
    expect(viewAll[0]?.getAttribute("href")).toBe("/w/helix/");
  });

  test("no overflow link when apps fit within the cap", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
      placements: [appPlacement("collateral"), appPlacement("salesforce")],
    });

    expect(byTestId(mounted.container, "sidebar-workspace-app")).toHaveLength(2);
    expect(byTestId(mounted.container, "sidebar-workspace-view-all")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (5) Selection + navigation
// ---------------------------------------------------------------------------

describe("WorkspaceNav — selection + navigation", () => {
  test("selecting a shared workspace fires the setter once and navigates to /w/<slug>/", async () => {
    mounted = await mount({
      workspaces: [PERSONAL, HELIX, ACME],
      activeId: "ws_user_u1",
    });
    setActiveSpy.mockClear();

    const helixHeader = headerById(mounted.container)["ws_helix"] as HTMLButtonElement;
    await act(async () => {
      helixHeader?.click();
    });

    expect(setActiveSpy).toHaveBeenCalledTimes(1);
    expect(setActiveSpy.mock.calls[0]?.[0]).toBe("ws_helix");
    expect(mounted.navigationTarget()).toBe("/w/helix/");
  });

  test("selecting Personal opens its own overview (/w/<slug>/), not the global grid", async () => {
    mounted = await mount({
      workspaces: [PERSONAL, HELIX],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
    });
    setActiveSpy.mockClear();

    const personalHeader = headerById(mounted.container)["ws_user_u1"] as HTMLButtonElement;
    await act(async () => {
      personalHeader?.click();
    });

    expect(setActiveSpy).toHaveBeenCalledTimes(1);
    expect(setActiveSpy.mock.calls[0]?.[0]).toBe("ws_user_u1");
    expect(mounted.navigationTarget()).toBe("/w/user_u1/");
  });

  test("re-selecting the focused workspace does not fire the setter (T009 equality guard)", async () => {
    mounted = await mount({
      workspaces: [PERSONAL, HELIX],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
    });
    setActiveSpy.mockClear();

    const helixHeader = headerById(mounted.container)["ws_helix"] as HTMLButtonElement;
    await act(async () => {
      helixHeader?.click();
    });

    // Navigated to its overview, but the setter never fired (already focused).
    expect(setActiveSpy).toHaveBeenCalledTimes(0);
    expect(mounted.navigationTarget()).toBe("/w/helix/");
  });
});

// ---------------------------------------------------------------------------
// (6) Affordances + collapsed mode
// ---------------------------------------------------------------------------

describe("WorkspaceNav — affordances + collapsed mode", () => {
  test("renders the add-workspace and New workspace affordances", async () => {
    mounted = await mount({ workspaces: [PERSONAL], activeId: "ws_user_u1" });
    expect(byTestId(mounted.container, "sidebar-workspace-add")).toHaveLength(1);
    expect(byTestId(mounted.container, "sidebar-workspace-new")).toHaveLength(1);
  });

  test("collapsed mode renders avatar buttons only — no expanded subtree, no header", async () => {
    mounted = await mount({
      workspaces: [PERSONAL, HELIX],
      activeId: "ws_helix",
      placements: [...IDENTITY_PLACEMENTS, appPlacement("people")],
      collapsed: true,
    });

    expect(
      byTestId(mounted.container, "sidebar-workspace-nav")[0]?.getAttribute("data-collapsed"),
    ).toBe("true");
    // One avatar button per workspace, the focused one marked.
    const headers = headerById(mounted.container);
    expect(Object.keys(headers).sort()).toEqual(["ws_helix", "ws_user_u1"]);
    expect(headers["ws_helix"]?.getAttribute("data-focused")).toBe("true");
    // No nested contents / add affordances in icon-only mode.
    expect(byTestId(mounted.container, "sidebar-workspace-contents")).toHaveLength(0);
    expect(byTestId(mounted.container, "sidebar-workspace-add")).toHaveLength(0);
    expect(byTestId(mounted.container, "sidebar-workspace-new")).toHaveLength(0);
  });
});
