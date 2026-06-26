// ---------------------------------------------------------------------------
// CurrentRoomNav — the room you're in, as the parent of its contents.
//
// Pins:
//   1. The focused room renders as the current-room header; its identity
//      views (Conversations / Automations / Files) + Connectors + its apps
//      nest beneath it.
//   2. Identity apps route top-level (`/conversations`); Connectors routes to
//      the room's settings tab; apps route into `/w/<slug>/app/<route>`.
//   3. When focused on a SHARED room, a compact Personal way-home row appears
//      above it (and navigates to `/` on click). When focused on Personal,
//      there is no separate home row — the header IS Personal.
//   4. The app quick-list is capped at MAX_INLINE_APPS with a View-all
//      overflow link to the room overview.
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
const { CurrentRoomNav } = await import("../components/shell/CurrentRoomNav");

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
}: {
  workspaces: WorkspaceInfo[];
  activeId?: string;
  initialPath?: string;
  placements?: PlacementEntry[];
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
                <Route path="*" element={<CurrentRoomNav />} />
              </Routes>
            </ShellProvider>
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

const PERSONAL = ws({ id: "ws_user_u1", name: "Personal", isPersonal: true });
const HELIX = ws({ id: "ws_helix", name: "Helix" });

// ---------------------------------------------------------------------------
// (1) Focused on Personal (home)
// ---------------------------------------------------------------------------

describe("CurrentRoomNav — focused on Personal (home)", () => {
  test("renders the Personal header (no separate home row) + nested identity views", async () => {
    mounted = await mount({
      workspaces: [PERSONAL, HELIX],
      activeId: "ws_user_u1",
      placements: IDENTITY_PLACEMENTS,
    });

    // Exactly one room header — the Personal header — and it's the focused one.
    const headers = byTestId(mounted.container, "sidebar-room-header");
    expect(headers).toHaveLength(1);
    expect(headers[0]?.getAttribute("data-room-id")).toBe("ws_user_u1");
    expect(headers[0]?.getAttribute("data-focused")).toBe("true");
    expect(headers[0]?.textContent).toContain("Personal");

    // Identity views route top-level, and Connectors routes to the room's
    // settings tab (toSlug strips `ws_`: ws_user_u1 → user_u1).
    const hrefs = anchorHrefs(mounted.container);
    expect(hrefs).toContain("/conversations");
    expect(hrefs).toContain("/automations");
    expect(hrefs).toContain("/files");
    expect(hrefs).toContain("/w/user_u1/settings/connectors");
  });
});

// ---------------------------------------------------------------------------
// (2) Focused on a shared room
// ---------------------------------------------------------------------------

describe("CurrentRoomNav — focused on a shared room", () => {
  test("shows a Personal way-home row above the focused room, and the room's apps nest under it", async () => {
    mounted = await mount({
      workspaces: [PERSONAL, HELIX],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
      placements: [...IDENTITY_PLACEMENTS, appPlacement("people"), appPlacement("tasks")],
    });

    // Two headers: the Personal way-home row + the focused Helix header.
    const headers = byTestId(mounted.container, "sidebar-room-header");
    const byId = Object.fromEntries(headers.map((h) => [h.getAttribute("data-room-id"), h]));
    expect(byId["ws_user_u1"]?.getAttribute("data-focused")).toBe("false");
    expect(byId["ws_helix"]?.getAttribute("data-focused")).toBe("true");

    // Helix's apps nest under it, routed into the room.
    const appRows = byTestId(mounted.container, "sidebar-room-app");
    expect(appRows.map((r) => r.getAttribute("data-app-route")).sort()).toEqual([
      "people",
      "tasks",
    ]);
    expect(anchorHrefs(mounted.container)).toContain("/w/helix/app/people");
    // Connectors is the focused room's.
    expect(anchorHrefs(mounted.container)).toContain("/w/helix/settings/connectors");
  });

  test("clicking the Personal way-home row navigates home (/) and focuses Personal", async () => {
    mounted = await mount({
      workspaces: [PERSONAL, HELIX],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
      placements: IDENTITY_PLACEMENTS,
    });
    setActiveSpy.mockClear();

    const homeRow = byTestId(mounted.container, "sidebar-room-header").find(
      (h) => h.getAttribute("data-room-id") === "ws_user_u1",
    ) as HTMLButtonElement | undefined;
    await act(async () => {
      homeRow?.click();
    });

    expect(setActiveSpy).toHaveBeenCalledTimes(1);
    expect(setActiveSpy.mock.calls[0]?.[0]).toBe("ws_user_u1");
    expect(mounted.navigationTarget()).toBe("/");
  });
});

// ---------------------------------------------------------------------------
// (3) App quick-list cap + overflow
// ---------------------------------------------------------------------------

describe("CurrentRoomNav — app quick-list", () => {
  test("caps apps at MAX_INLINE_APPS with a View-all overflow link to the room overview", async () => {
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

    // 5 installed, capped at 4 shown.
    expect(byTestId(mounted.container, "sidebar-room-app")).toHaveLength(4);

    const viewAll = byTestId(mounted.container, "sidebar-room-view-all");
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

    expect(byTestId(mounted.container, "sidebar-room-app")).toHaveLength(2);
    expect(byTestId(mounted.container, "sidebar-room-view-all")).toHaveLength(0);
  });
});
