// ---------------------------------------------------------------------------
// SidebarWorkspaceNav (T013) — load-bearing UI contract.
//
// Six acceptance criteria pinned (per task spec § Tests Required > Sidebar):
//
//   1. Renders the user's workspaces with role badges, ordered
//      personal-first then shared alphabetically.
//   2. Expansion toggle — per-row state.
//   3. App selection drives `setActiveWorkspaceId` exactly once on
//      cross-workspace clicks; re-clicking the SAME app row does NOT
//      fire the setter again. **This is the equality-guard topology
//      pin** — a regression that lost the guard would silently
//      invalidate the REST cache on every click.
//   4. App selection navigates to `/w/<slug>/app/<route>`.
//   5. Persistence — last-viewed app survives a remount.
//   6. No active app → "Not viewing an app" fallback (covered in
//      `ComposerFooter.test.tsx`; mentioned here for the audit trail).
//
// Prefixed `b-` (after `a-t009-acceptance.test.ts`) so it loads before
// the suite's `mock.module("../api/client", ...)` stubs in
// `connector-sections.test.tsx`. The acceptance file installs partial
// mocks of the api client surface that would break this test's
// `setActiveWorkspaceId` import otherwise.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Track the current value here (mimicking api/client's module state)
// so `getActiveWorkspaceId` keeps working under the mock. Equality
// guard implemented manually to mirror the real setter — the test's
// adversarial assertion is "spy fires once per real change", which
// matches the api/client invariant pinned in api-client-lifecycle.test.ts.
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
const { SidebarWorkspaceNav } = await import("../components/shell/SidebarWorkspaceNav");
const { LAST_VIEWED_APP_STORAGE_KEY } = await import("../components/shell/WorkspaceAppList");

import type { WorkspaceInfo } from "../context/WorkspaceContext";

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
  currentPath(): string;
}

let mounted: Mounted | null = null;
let currentPath = "/";

function LocationProbe() {
  const loc = useLocation();
  currentPath = loc.pathname;
  return null;
}

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  currentPath = "/";
  setActiveSpy.mockClear();
  mockedActiveId = null;
  try {
    localStorage.removeItem(LAST_VIEWED_APP_STORAGE_KEY);
    localStorage.removeItem("nb_active_workspace");
  } catch {
    // ignored
  }
});

beforeEach(() => {
  setActiveSpy.mockClear();
  mockedActiveId = null;
});

function ws(over: Partial<WorkspaceInfo>): WorkspaceInfo {
  return {
    id: "ws_default",
    name: "Default",
    memberCount: 1,
    bundles: [],
    userRole: "admin",
    ...over,
  };
}

async function mount(opts: {
  workspaces: WorkspaceInfo[];
  activeId?: string;
  initialPath?: string;
}): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[opts.initialPath ?? "/"]}>
        <WorkspaceProvider initialWorkspaces={opts.workspaces} initialActiveId={opts.activeId}>
          <LocationProbe />
          <Routes>
            <Route path="*" element={<SidebarWorkspaceNav />} />
          </Routes>
        </WorkspaceProvider>
      </MemoryRouter>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return {
    container,
    currentPath: () => currentPath,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

function findByTestId(container: HTMLElement, testid: string): HTMLElement | null {
  const all = Array.from(container.getElementsByTagName("*"));
  for (const el of all) {
    if (el.getAttribute("data-testid") === testid) return el as HTMLElement;
  }
  return null;
}

function findAllByTestId(container: HTMLElement, testid: string): HTMLElement[] {
  const all = Array.from(container.getElementsByTagName("*"));
  return all.filter((el) => el.getAttribute("data-testid") === testid) as HTMLElement[];
}

function findWorkspaceRow(container: HTMLElement, wsId: string): HTMLElement | null {
  const rows = findAllByTestId(container, "workspace-row");
  return rows.find((r) => r.getAttribute("data-workspace-id") === wsId) ?? null;
}

function findToggle(row: HTMLElement): HTMLButtonElement | null {
  const all = Array.from(row.getElementsByTagName("*"));
  for (const el of all) {
    if (el.getAttribute("data-testid") === "workspace-row-toggle") {
      return el as HTMLButtonElement;
    }
  }
  return null;
}

function findAppRow(
  container: HTMLElement,
  wsId: string,
  appRoute: string,
): HTMLButtonElement | null {
  const rows = findAllByTestId(container, "workspace-app-row");
  return (rows.find(
    (r) =>
      r.getAttribute("data-workspace-id") === wsId && r.getAttribute("data-app-route") === appRoute,
  ) ?? null) as HTMLButtonElement | null;
}

// ---------------------------------------------------------------------------
// (1) Render: workspaces + role badges + ordering
// ---------------------------------------------------------------------------

describe("SidebarWorkspaceNav — render", () => {
  test("renders the user's workspaces with role badges, personal-first then shared alphabetical", async () => {
    mounted = await mount({
      workspaces: [
        ws({ id: "ws_helix", name: "Helix", userRole: "admin" }),
        ws({ id: "ws_user_u1", name: "Personal", isPersonal: true, userRole: "admin" }),
        ws({ id: "ws_acme", name: "Acme", userRole: "member" }),
      ],
      activeId: "ws_user_u1",
    });

    const rows = findAllByTestId(mounted.container, "workspace-row");
    const ids = rows.map((r) => r.getAttribute("data-workspace-id"));
    expect(ids).toEqual(["ws_user_u1", "ws_acme", "ws_helix"]);

    // Role badges visible — Stage 1 contract drives the rendered role
    // string ("admin" / "member"). RoleBadge renders the raw role
    // string verbatim.
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("admin");
    expect(text).toContain("member");
    expect(text).toContain("Personal");
    expect(text).toContain("Helix");
    expect(text).toContain("Acme");
  });

  test("renders the `+` affordance on the WORKSPACES heading", async () => {
    mounted = await mount({
      workspaces: [ws({ id: "ws_user_u1", name: "Personal", isPersonal: true })],
      activeId: "ws_user_u1",
    });
    expect(findByTestId(mounted.container, "sidebar-workspace-add")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (2) Expansion toggle — per-row state
// ---------------------------------------------------------------------------

describe("SidebarWorkspaceNav — expansion", () => {
  test("clicking a workspace row toggles its expanded state", async () => {
    const helix = ws({
      id: "ws_helix",
      name: "Helix",
      bundles: [{ name: "gmail" }, { name: "collateral-studio" }],
    });
    mounted = await mount({ workspaces: [helix], activeId: "ws_helix" });

    // Active workspace seeds expanded — start by collapsing.
    let row = findWorkspaceRow(mounted.container, "ws_helix");
    expect(row?.getAttribute("data-expanded")).toBe("true");
    expect(findByTestId(mounted.container, "workspace-app-list")).not.toBeNull();

    const toggle = findToggle(row!);
    await act(async () => {
      toggle?.click();
    });
    row = findWorkspaceRow(mounted.container, "ws_helix");
    expect(row?.getAttribute("data-expanded")).toBe("false");
    expect(findByTestId(mounted.container, "workspace-app-list")).toBeNull();

    await act(async () => {
      toggle?.click();
    });
    row = findWorkspaceRow(mounted.container, "ws_helix");
    expect(row?.getAttribute("data-expanded")).toBe("true");
  });

  test("expansion state is per-row (toggling one does not affect another)", async () => {
    mounted = await mount({
      workspaces: [
        ws({ id: "ws_a", name: "Alpha", bundles: [{ name: "gmail" }] }),
        ws({ id: "ws_b", name: "Bravo", bundles: [{ name: "crm" }] }),
      ],
      activeId: "ws_a",
    });

    // Active row (ws_a) is expanded; ws_b is collapsed.
    const rowA = findWorkspaceRow(mounted.container, "ws_a");
    const rowB = findWorkspaceRow(mounted.container, "ws_b");
    expect(rowA?.getAttribute("data-expanded")).toBe("true");
    expect(rowB?.getAttribute("data-expanded")).toBe("false");

    // Expand ws_b — must NOT collapse ws_a.
    const toggleB = findToggle(rowB!);
    await act(async () => {
      toggleB?.click();
    });
    expect(findWorkspaceRow(mounted.container, "ws_a")?.getAttribute("data-expanded")).toBe("true");
    expect(findWorkspaceRow(mounted.container, "ws_b")?.getAttribute("data-expanded")).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// (3) App selection — equality-guard topology pin (the load-bearing test)
// ---------------------------------------------------------------------------

describe("SidebarWorkspaceNav — app selection topology", () => {
  test("cross-workspace click calls setActiveWorkspaceId once; re-click on same app is a no-op (T009 equality guard)", async () => {
    const personal = ws({
      id: "ws_user_u1",
      name: "Personal",
      isPersonal: true,
      bundles: [{ name: "gmail" }],
    });
    const helix = ws({
      id: "ws_helix",
      name: "Helix",
      bundles: [{ name: "collateral-studio" }],
    });

    mounted = await mount({
      workspaces: [personal, helix],
      activeId: "ws_user_u1",
    });

    // Baseline: mount-time fired setActiveWorkspaceId once (the
    // initial active id). Reset so the test asserts only what
    // happens on clicks.
    setActiveSpy.mockClear();

    // Expand helix so its app rows are visible.
    const helixToggle = findToggle(findWorkspaceRow(mounted.container, "ws_helix")!);
    await act(async () => {
      helixToggle?.click();
    });

    // Click an app in helix — this is a cross-workspace click and
    // MUST fire the setter.
    const helixApp = findAppRow(mounted.container, "ws_helix", "collateral-studio");
    expect(helixApp).not.toBeNull();
    await act(async () => {
      helixApp?.click();
    });
    expect(setActiveSpy).toHaveBeenCalledTimes(1);
    expect(setActiveSpy.mock.calls[0]?.[0]).toBe("ws_helix");
    expect(mockedGetActiveWorkspaceId()).toBe("ws_helix");

    // Click the SAME app row again — the React-layer equality guard
    // (WorkspaceAppList.handleSelect) catches this and never calls
    // setActiveWorkspace, so the setter spy count stays at 1.
    // This is the regression the task spec calls out:
    //   "A regression where every app click fires the setter would
    //    defeat T009's equality guard — pin this".
    await act(async () => {
      helixApp?.click();
    });
    expect(setActiveSpy).toHaveBeenCalledTimes(1);

    // Click ANOTHER app in the same workspace — same workspace, so
    // also still a no-op for setActiveWorkspaceId. (Different app
    // navigates the router but does not switch workspaces.)
    // Use the personal workspace's already-rendered gmail row.
    const personalGmail = findAppRow(mounted.container, "ws_user_u1", "gmail");
    expect(personalGmail).not.toBeNull();
    await act(async () => {
      personalGmail?.click();
    });
    expect(setActiveSpy).toHaveBeenCalledTimes(2);
    expect(setActiveSpy.mock.calls[1]?.[0]).toBe("ws_user_u1");
  });
});

// ---------------------------------------------------------------------------
// (4) Navigation contract
// ---------------------------------------------------------------------------

describe("SidebarWorkspaceNav — navigation", () => {
  test("clicking an app pushes /w/<slug>/app/<route>", async () => {
    const helix = ws({
      id: "ws_helix",
      name: "Helix",
      bundles: [{ name: "collateral-studio" }],
    });
    mounted = await mount({
      workspaces: [helix],
      activeId: "ws_helix",
      initialPath: "/",
    });

    const app = findAppRow(mounted.container, "ws_helix", "collateral-studio");
    expect(app).not.toBeNull();
    await act(async () => {
      app?.click();
    });
    // Slug stripping rule: `toSlug("ws_helix")` → "helix".
    expect(mounted.currentPath()).toBe("/w/helix/app/collateral-studio");
  });
});

// ---------------------------------------------------------------------------
// (5) Persistence — last-viewed app survives a remount
// ---------------------------------------------------------------------------

describe("SidebarWorkspaceNav — persistence", () => {
  test("clicking an app persists the workspace+app pair to localStorage", async () => {
    const helix = ws({
      id: "ws_helix",
      name: "Helix",
      bundles: [{ name: "collateral-studio" }],
    });
    mounted = await mount({
      workspaces: [helix],
      activeId: "ws_helix",
    });

    const app = findAppRow(mounted.container, "ws_helix", "collateral-studio");
    await act(async () => {
      app?.click();
    });
    expect(localStorage.getItem(LAST_VIEWED_APP_STORAGE_KEY)).toBe("ws_helix:collateral-studio");
  });

  test("on remount, sidebar restores the persisted workspace as active", async () => {
    // Seed persistence directly — simulates a prior session.
    localStorage.setItem(LAST_VIEWED_APP_STORAGE_KEY, "ws_helix:collateral-studio");

    const personal = ws({
      id: "ws_user_u1",
      name: "Personal",
      isPersonal: true,
      bundles: [{ name: "gmail" }],
    });
    const helix = ws({
      id: "ws_helix",
      name: "Helix",
      bundles: [{ name: "collateral-studio" }],
    });
    // Mount with the personal workspace active — the restore effect
    // should swap to ws_helix on mount.
    mounted = await mount({
      workspaces: [personal, helix],
      activeId: "ws_user_u1",
    });

    // After mount, ws_helix should be the active workspace.
    expect(mockedGetActiveWorkspaceId()).toBe("ws_helix");
  });
});
