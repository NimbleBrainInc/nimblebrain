// ---------------------------------------------------------------------------
// WorkspaceSwitcher + WorkspaceNav — the sidebar's workspace contract.
//
// Pins:
//   1. The nav shows only the focused workspace, flat: Overview, its identity
//      views (Conversations / Automations / Files) routed to `/w/<slug>/<view>`,
//      Inbox, its apps routed to `/w/<slug>/app/<route>`, and a Connectors row
//      to `/w/<slug>/settings/connectors`. No other workspace appears in it.
//   2. The app quick-list caps at MAX_INLINE_APPS with a View-all overflow to
//      the workspace overview. The Connectors count comes from the shared
//      app-icons fetch.
//   3. The switcher's trigger names the focused workspace. Opened, it lists
//      every workspace alphabetically with the focused one selected, and the
//      filter box narrows the list.
//   4. Picking a workspace fires setActiveWorkspaceId once and navigates to its
//      overview `/w/<slug>/`; re-picking the focused one navigates without
//      firing the setter (equality guard). Enter picks the highlighted match.
//   5. The footer opens the focused workspace's settings and the new-workspace
//      page.
//   6. Collapsed, the nav renders the same destinations icon-only.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom builds its selector-parse errors from `window.SyntaxError`, which
// its Window does not define, and Base UI's popover probes selectors on open.
// Same shim as confirm-dialog.test.tsx.
{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

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
const { WorkspaceSwitcher } = await import("../components/shell/WorkspaceSwitcher");

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
                  <Route
                    path="*"
                    element={
                      <>
                        <WorkspaceSwitcher collapsed={collapsed} />
                        <WorkspaceNav collapsed={collapsed} />
                      </>
                    }
                  />
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
  localStorage.clear();
});

function ws(overrides: Partial<WorkspaceInfo> & { id: string; name: string }): WorkspaceInfo {
  return {
    connectorCount: 0,
    memberCount: 1,
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

function buttons(root: ParentNode, testid: string): HTMLButtonElement[] {
  return Array.from((root as Element).getElementsByTagName("button")).filter(
    (b) => b.getAttribute("data-testid") === testid,
  );
}

async function click(el: HTMLElement | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => el.click());
}

// The switcher's list renders in a portal on document.body.
async function openSwitcher() {
  await click(buttons(mounted!.container, "workspace-switcher-trigger")[0]);
}

function options(): HTMLButtonElement[] {
  return buttons(document.body, "workspace-switcher-option");
}

function switcherInput(): HTMLInputElement {
  const input = Array.from(document.body.getElementsByTagName("input")).find(
    (i) => i.getAttribute("data-testid") === "workspace-switcher-input",
  );
  if (!input) throw new Error("switcher is not open");
  return input;
}

// Events built from happy-dom's own window: its dispatchEvent rejects Bun's
// global Event classes.
const win = (globalThis as unknown as { window: typeof globalThis }).window;

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
}

async function press(input: HTMLInputElement, key: string) {
  await act(async () => {
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

const MINE = ws({ id: "ws_mine", name: "Mat's workspace" });
const HELIX = ws({ id: "ws_helix", name: "Helix" });
const ACME = ws({ id: "ws_acme", name: "Acme" });

// ---------------------------------------------------------------------------
// (1) One workspace, flat
// ---------------------------------------------------------------------------

describe("WorkspaceNav — the focused workspace only", () => {
  test("lists the focused workspace's views under /w/<slug>/ and no other workspace", async () => {
    mounted = await mount({
      workspaces: [MINE, HELIX, ACME],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
      placements: [...IDENTITY_PLACEMENTS, appPlacement("people"), appPlacement("tasks")],
      connectorCount: 4,
    });

    const nav = byTestId(mounted.container, "sidebar-workspace-nav");
    expect(nav).toHaveLength(1);
    expect(nav[0]?.getAttribute("data-workspace-id")).toBe("ws_helix");

    const hrefs = anchorHrefs(mounted.container);
    expect(hrefs).toEqual([
      "/w/helix/",
      "/w/helix/conversations",
      "/w/helix/automations",
      "/w/helix/files",
      "/w/helix/notifications",
      "/w/helix/app/people",
      "/w/helix/app/tasks",
      "/w/helix/settings/connectors",
    ]);
    expect(nav[0]?.textContent).not.toContain("Acme");
    expect(nav[0]?.textContent).not.toContain("Mat's workspace");

    // Connectors count badge reflects the focused workspace's installed count.
    const badge = byTestId(mounted.container, "sidebar-workspace-count");
    expect(badge).toHaveLength(1);
    expect(badge[0]?.textContent).toBe("4");
  });

  test("Overview is the current page only on the overview", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_helix",
      initialPath: "/w/helix/conversations",
      placements: IDENTITY_PLACEMENTS,
    });

    const current = Array.from(mounted.container.getElementsByTagName("a")).filter(
      (a) => a.getAttribute("aria-current") === "page",
    );
    expect(current.map((a) => a.getAttribute("href"))).toEqual(["/w/helix/conversations"]);
  });
});

// ---------------------------------------------------------------------------
// (2) App quick-list cap + overflow
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

  test("the open app is the only one marked aria-current=page", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_helix",
      initialPath: "/w/helix/app/salesforce",
      placements: [appPlacement("collateral"), appPlacement("salesforce"), appPlacement("apollo")],
    });

    // The only channel that tells assistive technology which app is open. The
    // active row is otherwise a background tint and a weight step, and neither
    // is exposed.
    const apps = byTestId(mounted.container, "sidebar-workspace-app");
    expect(apps).toHaveLength(3);

    const current = apps.filter((a) => a.getAttribute("aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(current[0]?.getAttribute("data-app-route")).toBe("salesforce");
    expect(apps.filter((a) => a.hasAttribute("aria-current"))).toHaveLength(1);
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
// (3) The switcher lists and filters
// ---------------------------------------------------------------------------

describe("WorkspaceSwitcher — list + filter", () => {
  test("the trigger names the focused workspace; the list is alphabetical with it selected", async () => {
    mounted = await mount({ workspaces: [MINE, HELIX, ACME], activeId: "ws_mine" });

    const trigger = buttons(mounted.container, "workspace-switcher-trigger")[0];
    expect(trigger?.textContent).toContain("Mat's workspace");

    await openSwitcher();
    expect(options().map((o) => o.getAttribute("data-workspace-id"))).toEqual([
      "ws_acme",
      "ws_helix",
      "ws_mine",
    ]);
    const selected = options().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.getAttribute("data-workspace-id"))).toEqual(["ws_mine"]);
  });

  test("typing narrows the list by name", async () => {
    mounted = await mount({ workspaces: [MINE, HELIX, ACME], activeId: "ws_mine" });
    await openSwitcher();

    await type(switcherInput(), "hel");

    expect(options().map((o) => o.getAttribute("data-workspace-id"))).toEqual(["ws_helix"]);
  });
});

// ---------------------------------------------------------------------------
// (4) Switching
// ---------------------------------------------------------------------------

describe("WorkspaceSwitcher — switching", () => {
  test("picking a workspace fires the setter once and navigates to /w/<slug>/", async () => {
    mounted = await mount({
      workspaces: [MINE, HELIX, ACME],
      activeId: "ws_mine",
      initialPath: "/w/mine/conversations",
    });
    setActiveSpy.mockClear();

    await openSwitcher();
    await click(options().find((o) => o.getAttribute("data-workspace-id") === "ws_helix"));

    expect(setActiveSpy).toHaveBeenCalledTimes(1);
    expect(setActiveSpy.mock.calls[0]?.[0]).toBe("ws_helix");
    expect(mounted.navigationTarget()).toBe("/w/helix/");
  });

  test("re-picking the focused workspace opens its overview without firing the setter", async () => {
    mounted = await mount({
      workspaces: [MINE, HELIX],
      activeId: "ws_helix",
      initialPath: "/w/helix/conversations",
    });
    setActiveSpy.mockClear();

    await openSwitcher();
    await click(options().find((o) => o.getAttribute("data-workspace-id") === "ws_helix"));

    expect(setActiveSpy).toHaveBeenCalledTimes(0);
    expect(mounted.navigationTarget()).toBe("/w/helix/");
  });

  test("Enter switches to the highlighted match", async () => {
    mounted = await mount({ workspaces: [MINE, HELIX, ACME], activeId: "ws_mine" });
    setActiveSpy.mockClear();
    await openSwitcher();

    await press(switcherInput(), "ArrowDown");
    await press(switcherInput(), "Enter");

    expect(setActiveSpy.mock.calls[0]?.[0]).toBe("ws_helix");
    expect(mounted.navigationTarget()).toBe("/w/helix/");
  });
});

// ---------------------------------------------------------------------------
// (5) Footer actions
// ---------------------------------------------------------------------------

describe("WorkspaceSwitcher — footer", () => {
  test("opens the focused workspace's settings", async () => {
    mounted = await mount({ workspaces: [MINE, HELIX], activeId: "ws_helix" });
    await openSwitcher();

    const settings = buttons(document.body, "workspace-switcher-settings")[0];
    expect(settings?.textContent).toContain("Helix settings");
    await click(settings);

    expect(mounted.navigationTarget()).toBe("/w/helix/settings");
  });

  test("New workspace opens the workspaces page", async () => {
    mounted = await mount({ workspaces: [MINE], activeId: "ws_mine" });
    await openSwitcher();

    await click(buttons(document.body, "workspace-switcher-new")[0]);

    expect(mounted.navigationTarget()).toBe("/org/workspaces");
  });
});

// ---------------------------------------------------------------------------
// (6) Collapsed
// ---------------------------------------------------------------------------

describe("WorkspaceNav — collapsed", () => {
  test("renders the same destinations icon-only, each with an accessible name", async () => {
    mounted = await mount({
      workspaces: [MINE, HELIX],
      activeId: "ws_helix",
      initialPath: "/w/helix/",
      placements: [...IDENTITY_PLACEMENTS, appPlacement("people")],
      collapsed: true,
    });

    const nav = byTestId(mounted.container, "sidebar-workspace-nav")[0];
    expect(nav?.getAttribute("data-collapsed")).toBe("true");
    const links = Array.from(nav!.getElementsByTagName("a"));
    expect(links.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Overview",
      "Conversations",
      "Automations",
      "Files",
      "Inbox",
      "people",
      "Connectors",
    ]);
    // Icon-only: no visible labels in the rail.
    for (const label of ["Overview", "Conversations", "Inbox", "Connectors"]) {
      expect(nav?.textContent).not.toContain(label);
    }
  });
});
