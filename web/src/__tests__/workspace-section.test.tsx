// ---------------------------------------------------------------------------
// WorkspaceSection — load-bearing UI contract (the OTHER rooms).
//
// The focused room and the Personal room are shown above in CurrentRoomNav;
// this list is every other room. Pins:
//   1. Lists the OTHER rooms only — Personal (home) and the focused room
//      (promoted into the current-room section) are excluded — alphabetically.
//   2. Clicking a row fires `setActiveWorkspaceId` exactly once — always a
//      cross-room switch, since the focused room is never in this list — and
//      navigates to `/w/<slug>/`.
//   3. The `+ add workspace` affordance is present.
//
// The focused room's apps + the active-route highlight moved to CurrentRoomNav
// (see current-room-nav.test.tsx).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

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

// Spread the preload's real-module snapshot (see web/test/setup.ts) so this
// whole-module mock exposes every api/client export; only the three below are
// overridden. Keeps the process-global mock registry complete even when it
// leaks into another suite mid-run (this file used to need a `b-` filename to
// win the load order; the snapshot makes that unnecessary).
mock.module("../api/client", () => ({
  ...realClient,
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
  initialPath = "/",
}: {
  workspaces: WorkspaceInfo[];
  activeId?: string;
  initialPath?: string;
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
  test("lists the OTHER rooms only — Personal excluded — alphabetically", async () => {
    mounted = await mount({
      workspaces: [
        ws({ id: "ws_helix", name: "Helix" }),
        ws({ id: "ws_user_u1", name: "Personal", isPersonal: true }),
        ws({ id: "ws_acme", name: "Acme" }),
      ],
      activeId: "ws_user_u1", // focused on Personal (home)
    });

    const ids = findAllByTestId(mounted.container, "sidebar-workspace-row").map((r) =>
      r.getAttribute("data-workspace-id"),
    );
    // Personal is home (shown in CurrentRoomNav); the rest are alphabetical.
    expect(ids).toEqual(["ws_acme", "ws_helix"]);
  });

  test("excludes the focused room — it's promoted into the current-room section", async () => {
    mounted = await mount({
      workspaces: [
        ws({ id: "ws_user_u1", name: "Personal", isPersonal: true }),
        ws({ id: "ws_helix", name: "Helix" }),
        ws({ id: "ws_acme", name: "Acme" }),
      ],
      activeId: "ws_helix", // focused on Helix
    });

    const ids = findAllByTestId(mounted.container, "sidebar-workspace-row").map((r) =>
      r.getAttribute("data-workspace-id"),
    );
    // Helix promoted out, Personal is home → only Acme remains.
    expect(ids).toEqual(["ws_acme"]);
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
// (2) Selection + navigation
// ---------------------------------------------------------------------------

describe("WorkspaceSection — selection + navigation", () => {
  test("clicking a room fires setActiveWorkspaceId once and navigates to /w/<slug>/", async () => {
    // A row here is always a non-focused room, so a click is always a
    // cross-room switch — the setter fires exactly once (T009: the api/client
    // equality guard never suppresses a real change).
    const personal = ws({ id: "ws_user_u1", name: "Personal", isPersonal: true });
    const helix = ws({ id: "ws_helix", name: "Helix" });
    const acme = ws({ id: "ws_acme", name: "Acme" });
    mounted = await mount({ workspaces: [personal, helix, acme], activeId: "ws_user_u1" });

    // Baseline: mount fired the setter once (the initial active id). Reset so
    // the test asserts only the click.
    setActiveSpy.mockClear();

    const helixRow = findRow(mounted.container, "ws_helix");
    await act(async () => {
      helixRow?.click();
    });

    expect(setActiveSpy).toHaveBeenCalledTimes(1);
    expect(setActiveSpy.mock.calls[0]?.[0]).toBe("ws_helix");
    expect(mockedGetActiveWorkspaceId()).toBe("ws_helix");
    // toSlug strips the `ws_` prefix: "ws_helix" → "helix".
    expect(mounted.navigationTarget()).toBe("/w/helix/");
  });
});
