// ---------------------------------------------------------------------------
// WorkspaceSection — load-bearing UI contract.
//
// Four pins:
//   1. Renders the user's workspaces in personal-first then shared
//      alphabetical order.
//   2. The active marker follows the ROUTE: a workspace row is active
//      only on `/w/<slug>/...`; on global routes (`/`, `/conversations`)
//      no workspace row is active (it must not double-light with Home).
//   3. Cross-workspace click fires `setActiveWorkspaceId` exactly once;
//      re-clicking the active workspace's row is a no-op for the
//      setter (T009 equality guard). Topology pin — a regression that
//      lost the guard would silently invalidate the REST cache on
//      every click.
//   4. Click navigates to `/w/<slug>/`.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mirror the api/client setter's equality guard so the spy fires only
// on real changes (matching the production invariant pinned in
// api-client-lifecycle.test.ts).
let mockedActiveId: string | null = null;
const setActiveSpy = mock((id: string | null) => {
  if (mockedActiveId === id) return;
  mockedActiveId = id;
});
const mockedGetActiveWorkspaceId = (): string | null => mockedActiveId;

// Spread the real module so this whole-module mock exposes every api/client
// export. Bun's `mock.module` is process-global; a partial stub leaking into
// another suite mid-run (under CI's parallelism) is what crashed bridge tests
// with "Export named 'getActiveWorkspaceId' not found" — and is why this file
// used to need a `b-` filename to win the load order. A complete mock is inert
// when it leaks; only the three below are overridden.
const actualClient = await import("../api/client");
mock.module("../api/client", () => ({
  ...actualClient,
  setActiveWorkspaceId: setActiveSpy,
  getActiveWorkspaceId: mockedGetActiveWorkspaceId,
  callTool: mock(async () => ({ structuredContent: null, content: [] })),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { WorkspaceSection } = await import("../components/shell/WorkspaceSection");
const { ShellProvider } = await import("../context/ShellContext");

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
  placements,
}: {
  workspaces: WorkspaceInfo[];
  activeId?: string;
  initialPath?: string;
  /** When provided, wrap in a ShellProvider so the inline app quick-list
   *  has placements to render. Omit to exercise the null-shell path. */
  placements?: PlacementEntry[];
}): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const routes = (
    <Routes>
      <Route path="*" element={<WorkspaceSection />} />
    </Routes>
  );

  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <React.StrictMode>
        <MemoryRouter initialEntries={[initialPath]}>
          <WorkspaceProvider initialWorkspaces={workspaces} initialActiveId={activeId}>
            <NavigationProbe />
            {placements ? (
              <ShellProvider
                value={{
                  forSlot: makeForSlot(placements),
                  mainRoutes: () => [],
                  // The shell reflects the focused (active) workspace; the
                  // inline app list gates on shellWorkspaceId === workspaceId.
                  shellWorkspaceId: activeId,
                }}
              >
                {routes}
              </ShellProvider>
            ) : (
              routes
            )}
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

// happy-dom's querySelectorAll throws on attribute selectors that
// node/jsdom handle fine. Walk elements manually to match the rest of
// the suite's convention.
function findAllByTestId(container: HTMLElement, testid: string): HTMLElement[] {
  const all = Array.from(container.getElementsByTagName("*"));
  return all.filter((el) => el.getAttribute("data-testid") === testid) as HTMLElement[];
}

function findRow(container: HTMLElement, wsId: string): HTMLButtonElement | null {
  return (findAllByTestId(container, "sidebar-workspace-row").find(
    (r) => r.getAttribute("data-workspace-id") === wsId,
  ) ?? null) as HTMLButtonElement | null;
}

// ---------------------------------------------------------------------------
// (1) Render + ordering
// ---------------------------------------------------------------------------

describe("WorkspaceSection — render + ordering", () => {
  test("renders the user's workspaces in personal-first then shared alphabetical order", async () => {
    mounted = await mount({
      workspaces: [
        ws({ id: "ws_helix", name: "Helix" }),
        ws({ id: "ws_user_u1", name: "Personal", isPersonal: true }),
        ws({ id: "ws_acme", name: "Acme" }),
      ],
      activeId: "ws_user_u1",
    });

    const ids = findAllByTestId(mounted.container, "sidebar-workspace-row").map((r) =>
      r.getAttribute("data-workspace-id"),
    );
    expect(ids).toEqual(["ws_user_u1", "ws_acme", "ws_helix"]);
  });

  test("renders the `+ add workspace` affordance", async () => {
    mounted = await mount({
      workspaces: [ws({ id: "ws_user_u1", name: "Personal", isPersonal: true })],
      activeId: "ws_user_u1",
    });

    expect(findAllByTestId(mounted.container, "sidebar-workspace-add").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (2) Active workspace marker
// ---------------------------------------------------------------------------

describe("WorkspaceSection — active state (route-driven)", () => {
  test("on /w/<slug>/, only that workspace row is active", async () => {
    const helix = ws({ id: "ws_helix", name: "Helix" });
    const personal = ws({ id: "ws_user_u1", name: "Personal", isPersonal: true });

    // The persisted active workspace (tool-scoping) is personal, but the
    // ROUTE is helix's overview. The highlight must follow the route.
    mounted = await mount({
      workspaces: [personal, helix],
      activeId: "ws_user_u1",
      initialPath: "/w/helix/",
    });

    expect(findRow(mounted.container, "ws_helix")?.getAttribute("data-is-active")).toBe("true");
    expect(findRow(mounted.container, "ws_user_u1")?.getAttribute("data-is-active")).toBe("false");

    // Exactly one active row at a time.
    const allActive = findAllByTestId(mounted.container, "sidebar-workspace-row").filter(
      (r) => r.getAttribute("data-is-active") === "true",
    );
    expect(allActive).toHaveLength(1);
  });

  test("on a global route (/), NO workspace row is active even with a persisted active workspace", async () => {
    // Regression pin for the two-active-links bug: `activeWorkspace` is
    // always set (it scopes tool dispatch), so a state-based highlight lit
    // a workspace row while Home was simultaneously active. On global
    // routes the workspace section must show zero active rows.
    const helix = ws({ id: "ws_helix", name: "Helix" });
    const personal = ws({ id: "ws_user_u1", name: "Personal", isPersonal: true });

    mounted = await mount({
      workspaces: [personal, helix],
      activeId: "ws_helix",
      initialPath: "/",
    });

    const allActive = findAllByTestId(mounted.container, "sidebar-workspace-row").filter(
      (r) => r.getAttribute("data-is-active") === "true",
    );
    expect(allActive).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (3) Click topology — equality-guard pin
// ---------------------------------------------------------------------------

describe("WorkspaceSection — selection topology (equality guard)", () => {
  test("cross-workspace click fires setActiveWorkspaceId once; re-click on active is a no-op (T009 equality guard)", async () => {
    const personal = ws({ id: "ws_user_u1", name: "Personal", isPersonal: true });
    const helix = ws({ id: "ws_helix", name: "Helix" });

    mounted = await mount({ workspaces: [personal, helix], activeId: "ws_user_u1" });

    // Baseline: mount-time fired setActiveWorkspaceId once (the initial
    // active id). Reset so the test asserts only what happens on clicks.
    setActiveSpy.mockClear();

    // Click helix — cross-workspace click MUST fire the setter exactly once.
    const helixRow = findRow(mounted.container, "ws_helix");
    await act(async () => {
      helixRow?.click();
    });
    expect(setActiveSpy).toHaveBeenCalledTimes(1);
    expect(setActiveSpy.mock.calls[0]?.[0]).toBe("ws_helix");
    expect(mockedGetActiveWorkspaceId()).toBe("ws_helix");

    // Click the SAME row again. The React-layer equality guard in
    // WorkspaceSection.handleSelect catches this and never calls
    // setActiveWorkspace, so the setter spy count stays at 1.
    // Regression this pins: "every row click fires the setter."
    await act(async () => {
      helixRow?.click();
    });
    expect(setActiveSpy).toHaveBeenCalledTimes(1);

    // Cross-workspace click again — back to personal — fires once more.
    const personalRow = findRow(mounted.container, "ws_user_u1");
    await act(async () => {
      personalRow?.click();
    });
    expect(setActiveSpy).toHaveBeenCalledTimes(2);
    expect(setActiveSpy.mock.calls[1]?.[0]).toBe("ws_user_u1");
  });
});

// ---------------------------------------------------------------------------
// (4) Navigation contract
// ---------------------------------------------------------------------------

describe("WorkspaceSection — navigation", () => {
  test("clicking a workspace row navigates to /w/<slug>/", async () => {
    const helix = ws({ id: "ws_helix", name: "Helix" });
    mounted = await mount({
      workspaces: [ws({ id: "ws_user_u1", name: "Personal", isPersonal: true }), helix],
      activeId: "ws_user_u1",
    });

    const helixRow = findRow(mounted.container, "ws_helix");
    await act(async () => {
      helixRow?.click();
    });
    // toSlug strips the `ws_` prefix: "ws_helix" → "helix".
    expect(mounted.navigationTarget()).toBe("/w/helix/");
  });
});

// ---------------------------------------------------------------------------
// (5) Inline app quick-list
// ---------------------------------------------------------------------------

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

function appRows(container: HTMLElement): HTMLAnchorElement[] {
  return findAllByTestId(container, "sidebar-workspace-app") as unknown as HTMLAnchorElement[];
}

describe("WorkspaceSection — inline app quick-list", () => {
  test("renders the focused workspace's apps, capped at MAX_INLINE_APPS, with a View-all overflow link", async () => {
    const helix = ws({ id: "ws_helix", name: "Helix" });
    mounted = await mount({
      workspaces: [ws({ id: "ws_user_u1", name: "Personal", isPersonal: true }), helix],
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

    // 5 apps installed, capped at 4 shown.
    expect(appRows(mounted.container)).toHaveLength(4);
    // Container reports the true (uncapped) count for the overflow copy.
    const group = findAllByTestId(mounted.container, "sidebar-workspace-apps");
    expect(group).toHaveLength(1);
    expect(group[0]?.getAttribute("data-app-count")).toBe("5");

    const viewAll = findAllByTestId(mounted.container, "sidebar-workspace-view-all");
    expect(viewAll).toHaveLength(1);
    expect(viewAll[0]?.textContent).toContain("View all 5 apps");
    expect(viewAll[0]?.getAttribute("href")).toBe("/w/helix/");
  });

  test("no overflow link when apps fit within the cap", async () => {
    const helix = ws({ id: "ws_helix", name: "Helix" });
    mounted = await mount({
      workspaces: [helix],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
      placements: [appPlacement("collateral"), appPlacement("salesforce")],
    });

    expect(appRows(mounted.container)).toHaveLength(2);
    expect(findAllByTestId(mounted.container, "sidebar-workspace-view-all")).toHaveLength(0);
  });

  test("inline apps render only under the focused workspace", async () => {
    const helix = ws({ id: "ws_helix", name: "Helix" });
    const personal = ws({ id: "ws_user_u1", name: "Personal", isPersonal: true });
    mounted = await mount({
      workspaces: [personal, helix],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
      placements: [appPlacement("collateral")],
    });

    // Exactly one app group, and it sits under the focused (active) row.
    expect(findAllByTestId(mounted.container, "sidebar-workspace-apps")).toHaveLength(1);
  });

  test("each app links into /w/<slug>/app/<route>", async () => {
    const helix = ws({ id: "ws_helix", name: "Helix" });
    mounted = await mount({
      workspaces: [helix],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
      placements: [appPlacement("collateral", { route: "@nb/collateral", label: "Collateral" })],
    });

    const [row] = appRows(mounted.container);
    expect(row?.getAttribute("data-app-route")).toBe("@nb/collateral");
    expect(row?.getAttribute("href")?.startsWith("/w/helix/app/")).toBe(true);
  });

  test("the app matching the current route is marked active", async () => {
    const helix = ws({ id: "ws_helix", name: "Helix" });
    mounted = await mount({
      workspaces: [helix],
      activeId: "ws_helix",
      initialPath: "/w/helix/app/salesforce",
      placements: [
        appPlacement("collateral", { priority: 10 }),
        appPlacement("salesforce", { priority: 20 }),
      ],
    });

    const active = appRows(mounted.container).filter(
      (r) => r.getAttribute("data-is-active") === "true",
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.getAttribute("data-app-route")).toBe("salesforce");
  });

  test("active highlight is exact — a route that is a string prefix of the current one stays inactive", async () => {
    // Regression pin: `crm` is a string prefix of `crm-archive`. A
    // startsWith match would light BOTH rows when viewing crm-archive.
    // App routes are leaf paths, so the match must be exact.
    const helix = ws({ id: "ws_helix", name: "Helix" });
    mounted = await mount({
      workspaces: [helix],
      activeId: "ws_helix",
      initialPath: "/w/helix/app/crm-archive",
      placements: [
        appPlacement("crm", { priority: 10 }),
        appPlacement("crm-archive", { priority: 20 }),
      ],
    });

    const active = appRows(mounted.container).filter(
      (r) => r.getAttribute("data-is-active") === "true",
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.getAttribute("data-app-route")).toBe("crm-archive");
  });

  test("renders nothing when the shell has no placements (null-shell path)", async () => {
    const helix = ws({ id: "ws_helix", name: "Helix" });
    mounted = await mount({
      workspaces: [helix],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
      // no `placements` → no ShellProvider → useShellContext() is null
    });

    expect(findAllByTestId(mounted.container, "sidebar-workspace-apps")).toHaveLength(0);
  });
});
