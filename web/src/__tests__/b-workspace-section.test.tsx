// ---------------------------------------------------------------------------
// WorkspaceSection — load-bearing UI contract.
//
// Four pins:
//   1. Renders the user's workspaces in personal-first then shared
//      alphabetical order.
//   2. Active workspace gets the `data-is-active="true"` marker.
//   3. Cross-workspace click fires `setActiveWorkspaceId` exactly once;
//      re-clicking the active workspace's row is a no-op for the
//      setter (T009 equality guard). Topology pin — a regression that
//      lost the guard would silently invalidate the REST cache on
//      every click.
//   4. Click navigates to `/w/<slug>/`.
//
// Prefixed `b-` (after `a-t009-acceptance.test.ts`) so it loads before
// the suite's `mock.module("../api/client", ...)` stubs in
// `connector-sections.test.tsx`. The acceptance file installs partial
// mocks of the api client surface that would break this test's
// `setActiveWorkspaceId` import otherwise.
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

mock.module("../api/client", () => ({
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

import type { WorkspaceInfo } from "../context/WorkspaceContext";

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

async function mount({
  workspaces,
  activeId,
}: {
  workspaces: WorkspaceInfo[];
  activeId?: string;
}): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <React.StrictMode>
        <MemoryRouter initialEntries={["/"]}>
          <WorkspaceProvider initialWorkspaces={workspaces} initialActiveId={activeId}>
            <NavigationProbe />
            <Routes>
              <Route path="*" element={<WorkspaceSection />} />
            </Routes>
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

describe("WorkspaceSection — active state", () => {
  test("only the active workspace row carries data-is-active='true'", async () => {
    const helix = ws({ id: "ws_helix", name: "Helix" });
    const personal = ws({ id: "ws_user_u1", name: "Personal", isPersonal: true });

    mounted = await mount({ workspaces: [personal, helix], activeId: "ws_helix" });

    const helixRow = findRow(mounted.container, "ws_helix");
    const personalRow = findRow(mounted.container, "ws_user_u1");
    expect(helixRow?.getAttribute("data-is-active")).toBe("true");
    expect(personalRow?.getAttribute("data-is-active")).toBe("false");

    // Exactly one active row at a time — pins a regression where
    // active state could be applied to multiple rows simultaneously.
    const allActive = findAllByTestId(mounted.container, "sidebar-workspace-row").filter(
      (r) => r.getAttribute("data-is-active") === "true",
    );
    expect(allActive).toHaveLength(1);
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
