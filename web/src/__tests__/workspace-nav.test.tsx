// ---------------------------------------------------------------------------
// WorkspaceSwitcher + WorkspaceNav — the sidebar's workspace contract.
//
// Pins:
//   1. The nav shows only the focused workspace, flat: Overview, its identity
//      views (Conversations / Tasks / Files) routed to `/w/<slug>/<view>`,
//      and its apps routed to `/w/<slug>/app/<route>`. No other
//      workspace appears in it.
//   2. The app quick-list caps at MAX_INLINE_APPS with a View-all overflow to
//      the workspace overview.
//   3. The switcher's trigger names the focused workspace. Opened, it lists
//      every workspace alphabetically with the focused one selected, and the
//      filter box narrows the list.
//   4. Picking a workspace fires setActiveWorkspaceId once and navigates to its
//      overview `/w/<slug>/`; re-picking the focused one navigates without
//      firing the setter (equality guard). Enter picks the highlighted match.
//   5. The footer opens the focused workspace's settings and the new-workspace
//      page.
//   6. Collapsed, the nav renders the same destinations icon-only.
//   7. The APPS header carries a "+" to the connector catalog for a member
//      who may write the workspace, even before any app is installed, and
//      no "+" for anyone else.
//   8. Installed connectors with no view share one row under the apps, to the
//      installed list; one with a view is never counted there.
//   9. With nothing installed, the expanded APPS section shows an "Add an app"
//      row to the catalog, once the installed list names this workspace.
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
const { MAX_INLINE_APPS } = await import("../lib/workspace-apps");

import type { InstalledConnector } from "../api/client";
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
  installed,
  installedFor = activeId,
}: {
  workspaces: WorkspaceInfo[];
  activeId?: string;
  initialPath?: string;
  placements?: PlacementEntry[];
  /** The installed connectors, read as belonging to `installedFor`. */
  installed?: InstalledConnector[];
  /** The workspace the installed list names; `activeId` unless a test stales it. */
  installedFor?: string;
  collapsed?: boolean;
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
            <WorkspaceAppIconsContext.Provider
              value={{
                iconFor: () => undefined,
                connectors:
                  installed && installedFor ? { workspaceId: installedFor, installed } : undefined,
              }}
            >
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

function installedConnector(serverName: string, displayName = serverName): InstalledConnector {
  return {
    serverName,
    connectorName: serverName,
    displayName,
    disconnectable: false,
    version: "1.0.0",
    state: "running",
    scope: "workspace",
    interactive: false,
    toolCount: 1,
    status: "ready",
  };
}

const IDENTITY_PLACEMENTS: PlacementEntry[] = [
  identityPlacement("conversations", 1),
  identityPlacement("tasks", 2),
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

const MINE = ws({ id: "ws_00488fa17f87e9a3", name: "Mat's workspace" });
const HELIX = ws({ id: "ws_003eba8844413cd9", name: "Helix" });
const ACME = ws({ id: "ws_000f7ed6658f9d30", name: "Acme" });

// ---------------------------------------------------------------------------
// (1) One workspace, flat
// ---------------------------------------------------------------------------

describe("WorkspaceNav — the focused workspace only", () => {
  test("lists the focused workspace's views under /w/<slug>/ and no other workspace", async () => {
    mounted = await mount({
      workspaces: [MINE, HELIX, ACME],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [...IDENTITY_PLACEMENTS, appPlacement("people"), appPlacement("todos")],
    });

    const nav = byTestId(mounted.container, "sidebar-workspace-nav");
    expect(nav).toHaveLength(1);
    expect(nav[0]?.getAttribute("data-workspace-id")).toBe("ws_003eba8844413cd9");

    const hrefs = anchorHrefs(mounted.container);
    expect(hrefs).toEqual([
      "/w/003eba8844413cd9/",
      "/w/003eba8844413cd9/conversations",
      "/w/003eba8844413cd9/tasks",
      "/w/003eba8844413cd9/files",
      "/w/003eba8844413cd9/settings/connectors/browse",
      "/w/003eba8844413cd9/app/people",
      "/w/003eba8844413cd9/app/todos",
    ]);
    expect(nav[0]?.textContent).not.toContain("Acme");
    expect(nav[0]?.textContent).not.toContain("Mat's workspace");
  });

  test("Overview is the current page only on the overview", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/conversations",
      placements: IDENTITY_PLACEMENTS,
    });

    const current = Array.from(mounted.container.getElementsByTagName("a")).filter(
      (a) => a.getAttribute("aria-current") === "page",
    );
    expect(current.map((a) => a.getAttribute("href"))).toEqual([
      "/w/003eba8844413cd9/conversations",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (2) App quick-list cap + overflow
// ---------------------------------------------------------------------------

describe("WorkspaceNav — app quick-list", () => {
  test("caps apps at MAX_INLINE_APPS with a View-all overflow to the overview", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: Array.from({ length: MAX_INLINE_APPS + 1 }, (_, i) =>
        appPlacement(`app-${i}`, { priority: (i + 1) * 10 }),
      ),
    });

    expect(byTestId(mounted.container, "sidebar-workspace-app")).toHaveLength(MAX_INLINE_APPS);

    const viewAll = byTestId(mounted.container, "sidebar-workspace-view-all");
    expect(viewAll).toHaveLength(1);
    expect(viewAll[0]?.textContent).toContain(`View all ${MAX_INLINE_APPS + 1} apps`);
    expect(viewAll[0]?.getAttribute("href")).toBe("/w/003eba8844413cd9/");
  });

  test("the open app is the only one marked aria-current=page", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/app/salesforce",
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

  test("an app with several views lists them beneath it only while it is open", async () => {
    const people = [
      appPlacement("people", { priority: 10, label: "Contacts", route: "people" }),
      appPlacement("people", {
        priority: 11,
        label: "Organizations",
        route: "people/organizations",
        resourceUri: "ui://people/organizations",
      }),
    ];
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [...people, appPlacement("todos", { priority: 20 })],
    });

    // Closed: one row per app, opening on the app's first view, and no views listed.
    const closed = byTestId(mounted.container, "sidebar-workspace-app");
    expect(closed.map((a) => a.getAttribute("href"))).toEqual([
      "/w/003eba8844413cd9/app/people",
      "/w/003eba8844413cd9/app/todos",
    ]);
    expect(byTestId(mounted.container, "sidebar-workspace-app-view")).toHaveLength(0);
    mounted.unmount();

    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/app/people/organizations",
      placements: [...people, appPlacement("todos", { priority: 20 })],
    });

    // Open: its views list beneath it, and the view on screen is the current page.
    // The app's own row is not: the page is one of its views.
    const views = byTestId(mounted.container, "sidebar-workspace-app-view");
    expect(views.map((v) => v.textContent)).toEqual(["Contacts", "Organizations"]);
    expect(views.map((v) => v.getAttribute("aria-current"))).toEqual([null, "page"]);
    const apps = byTestId(mounted.container, "sidebar-workspace-app");
    expect(apps).toHaveLength(2);
    expect(apps.filter((a) => a.hasAttribute("aria-current"))).toHaveLength(0);
  });

  test("an app with several views is named by its connector, or its first view until that loads", async () => {
    const placements = [
      appPlacement("people", { priority: 10, label: "Contacts", route: "people" }),
      appPlacement("people", {
        priority: 11,
        label: "Organizations",
        route: "people/organizations",
        resourceUri: "ui://people/organizations",
      }),
    ];
    // The row's last child is its label; before it sits the letter avatar.
    const label = () =>
      byTestId(mounted!.container, "sidebar-workspace-app").map(
        (a) => a.lastElementChild?.textContent,
      );

    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements,
    });
    expect(label()).toEqual(["Contacts"]);
    mounted.unmount();

    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements,
      installed: [installedConnector("people", "People")],
    });
    expect(label()).toEqual(["People"]);
    mounted.unmount();

    // A list read for another workspace does not name this one's apps.
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements,
      installed: [installedConnector("people", "People")],
      installedFor: ACME.id,
    });
    expect(label()).toEqual(["Contacts"]);
  });

  test("the cap and the View-all count are in apps, not in the views they place", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [
        appPlacement("people", { priority: 10, route: "people" }),
        appPlacement("people", {
          priority: 11,
          route: "people/organizations",
          resourceUri: "ui://people/organizations",
        }),
        appPlacement("people", {
          priority: 12,
          route: "people/opportunities",
          resourceUri: "ui://people/opportunities",
        }),
        appPlacement("todos", { priority: 20 }),
        appPlacement("memory", { priority: 30 }),
      ],
    });

    // Five placements, three apps: all three fit under the cap of four.
    expect(byTestId(mounted.container, "sidebar-workspace-app")).toHaveLength(3);
    expect(byTestId(mounted.container, "sidebar-workspace-view-all")).toHaveLength(0);
  });

  test("collapsed, an app with several views is one icon, marked when a view is open", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/app/people/organizations",
      collapsed: true,
      placements: [
        appPlacement("people", { priority: 10, route: "people" }),
        appPlacement("people", {
          priority: 11,
          route: "people/organizations",
          resourceUri: "ui://people/organizations",
        }),
      ],
    });

    const apps = byTestId(mounted.container, "sidebar-workspace-app");
    expect(apps).toHaveLength(1);
    expect(apps[0]?.getAttribute("aria-current")).toBe("page");
    expect(byTestId(mounted.container, "sidebar-workspace-app-view")).toHaveLength(0);
  });

  test("no overflow link when apps fit within the cap", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [appPlacement("collateral"), appPlacement("salesforce")],
    });

    expect(byTestId(mounted.container, "sidebar-workspace-app")).toHaveLength(2);
    expect(byTestId(mounted.container, "sidebar-workspace-view-all")).toHaveLength(0);
  });
});

describe("WorkspaceNav — pinned apps", () => {
  const routes = () =>
    byTestId(mounted!.container, "sidebar-workspace-app").map((a) =>
      a.getAttribute("data-app-route"),
    );
  const pin = (serverName: string) =>
    click(
      buttons(mounted!.container, "sidebar-workspace-app-pin").find(
        (b) => b.getAttribute("data-app-route") === serverName,
      ),
    );

  test("pinning moves an app to the top, in pin order, and unpinning puts it back", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [
        appPlacement("crm", { priority: 10 }),
        appPlacement("tasks", { priority: 20 }),
        appPlacement("outbound", { priority: 30 }),
      ],
    });
    expect(routes()).toEqual(["crm", "tasks", "outbound"]);

    await pin("outbound");
    await pin("tasks");
    expect(routes()).toEqual(["outbound", "tasks", "crm"]);
    const pressed = buttons(mounted.container, "sidebar-workspace-app-pin").map((b) =>
      b.getAttribute("aria-pressed"),
    );
    expect(pressed).toEqual(["true", "true", "false"]);

    await pin("outbound");
    expect(routes()).toEqual(["tasks", "crm", "outbound"]);
  });

  test("a pinned app past the inline cap is shown", async () => {
    localStorage.setItem("nb:pinned-apps:ws_003eba8844413cd9", JSON.stringify(["last"]));
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [
        ...Array.from({ length: MAX_INLINE_APPS }, (_, i) =>
          appPlacement(`app-${i}`, { priority: (i + 1) * 10 }),
        ),
        appPlacement("last", { priority: 999 }),
      ],
    });
    expect(routes()[0]).toBe("last");
    expect(routes()).toHaveLength(MAX_INLINE_APPS);
  });

  test("pins belong to one workspace", async () => {
    localStorage.setItem("nb:pinned-apps:ws_000f7ed6658f9d30", JSON.stringify(["outbound"]));
    mounted = await mount({
      workspaces: [HELIX, ACME],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [
        appPlacement("crm", { priority: 10 }),
        appPlacement("outbound", { priority: 30 }),
      ],
    });
    expect(routes()).toEqual(["crm", "outbound"]);
  });

  test("a stored value that is not a list of names is ignored", async () => {
    localStorage.setItem("nb:pinned-apps:ws_003eba8844413cd9", '{"outbound":true}');
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [
        appPlacement("crm", { priority: 10 }),
        appPlacement("outbound", { priority: 30 }),
      ],
    });
    expect(routes()).toEqual(["crm", "outbound"]);
  });
});

describe("WorkspaceNav — add a connector", () => {
  test("the APPS header carries a + to the connector catalog", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [appPlacement("people")],
    });

    const add = byTestId(mounted.container, "sidebar-add-connector");
    expect(add).toHaveLength(1);
    expect(add[0]?.getAttribute("href")).toBe("/w/003eba8844413cd9/settings/connectors/browse");
    expect(add[0]?.getAttribute("aria-label")).toBe("Add apps and tools");
    expect(add[0]?.parentElement?.textContent).toBe("Apps");
  });

  test("a workspace with no apps still shows APPS and its +", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
    });

    expect(byTestId(mounted.container, "sidebar-add-connector")).toHaveLength(1);
    expect(byTestId(mounted.container, "sidebar-workspace-nav")[0]?.textContent).toContain("Apps");
  });

  test("a workspace with nothing installed shows an Add an app row", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      installed: [],
    });

    const empty = byTestId(mounted.container, "sidebar-workspace-apps-empty");
    expect(empty).toHaveLength(1);
    expect(empty[0]?.getAttribute("href")).toBe("/w/003eba8844413cd9/settings/connectors/browse");
    expect(empty[0]?.textContent).toBe("Add an app");
  });

  test("no Add an app row before the installed list names this workspace", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
    });

    expect(byTestId(mounted.container, "sidebar-workspace-apps-empty")).toHaveLength(0);
  });

  test("no Add an app row once an app is installed, or when collapsed", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [appPlacement("people")],
      installed: [installedConnector("people")],
    });
    expect(byTestId(mounted.container, "sidebar-workspace-apps-empty")).toHaveLength(0);
    mounted.unmount();

    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      installed: [],
      collapsed: true,
    });
    expect(byTestId(mounted.container, "sidebar-workspace-apps-empty")).toHaveLength(0);
  });

  test("a member who cannot write the workspace gets no +", async () => {
    mounted = await mount({
      workspaces: [ws({ id: "ws_003eba8844413cd9", name: "Helix", userRole: "member" })],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [appPlacement("people")],
    });

    expect(byTestId(mounted.container, "sidebar-add-connector")).toHaveLength(0);
    expect(byTestId(mounted.container, "sidebar-workspace-app")).toHaveLength(1);
  });

  test("no connectors without a view, no shared row", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [appPlacement("people")],
      installed: [installedConnector("people")],
    });

    expect(byTestId(mounted.container, "sidebar-workspace-tools")).toHaveLength(0);
    expect(anchorHrefs(mounted.container)).not.toContain("/w/003eba8844413cd9/settings/connectors");
  });
});

describe("WorkspaceNav — connectors without a view", () => {
  test("share one row after the apps, counting only those without a view", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [appPlacement("people")],
      installed: [
        installedConnector("people"),
        installedConnector("gmail", "Gmail"),
        installedConnector("granola", "Granola"),
      ],
    });

    const row = byTestId(mounted.container, "sidebar-workspace-tools");
    expect(row).toHaveLength(1);
    expect(row[0]?.getAttribute("href")).toBe("/w/003eba8844413cd9/settings/connectors");
    expect(row[0]?.textContent).toContain("2 more connected");
    expect(row[0]?.getAttribute("title")).toBe("Gmail, Granola");
    // After the apps.
    const hrefs = anchorHrefs(mounted.container);
    expect(hrefs.indexOf("/w/003eba8844413cd9/settings/connectors")).toBeGreaterThan(
      hrefs.indexOf("/w/003eba8844413cd9/app/people"),
    );
  });

  test("a single one is named; with no apps the count drops 'more'", async () => {
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      installed: [installedConnector("gmail", "Gmail")],
    });
    expect(byTestId(mounted.container, "sidebar-workspace-tools")[0]?.textContent).toEndWith(
      "Gmail",
    );
    mounted.unmount();

    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      installed: [installedConnector("gmail", "Gmail"), installedConnector("exa", "Exa")],
    });
    expect(byTestId(mounted.container, "sidebar-workspace-tools")[0]?.textContent).toEndWith(
      "2 connected",
    );
  });

  test("an app past the inline cap is still an app, not counted in the row", async () => {
    const appNames = Array.from({ length: MAX_INLINE_APPS + 1 }, (_, i) => `app-${i}`);
    mounted = await mount({
      workspaces: [HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: appNames.map((name, i) => appPlacement(name, { priority: (i + 1) * 10 })),
      installed: [
        ...appNames.map((name) => installedConnector(name)),
        installedConnector("gmail", "Gmail"),
      ],
    });

    expect(byTestId(mounted.container, "sidebar-workspace-view-all")).toHaveLength(1);
    expect(byTestId(mounted.container, "sidebar-workspace-tools")[0]?.textContent).toEndWith(
      "Gmail",
    );
  });

  test("no row while the installed list still names another workspace", async () => {
    mounted = await mount({
      workspaces: [HELIX, ACME],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      installed: [installedConnector("gmail", "Gmail")],
      installedFor: ACME.id,
    });

    expect(byTestId(mounted.container, "sidebar-workspace-tools")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// (3) The switcher lists and filters
// ---------------------------------------------------------------------------

describe("WorkspaceSwitcher — list + filter", () => {
  test("the trigger names the focused workspace; the list is alphabetical with it selected", async () => {
    mounted = await mount({ workspaces: [MINE, HELIX, ACME], activeId: "ws_00488fa17f87e9a3" });

    const trigger = buttons(mounted.container, "workspace-switcher-trigger")[0];
    expect(trigger?.textContent).toContain("Mat's workspace");

    await openSwitcher();
    expect(options().map((o) => o.getAttribute("data-workspace-id"))).toEqual([
      "ws_000f7ed6658f9d30",
      "ws_003eba8844413cd9",
      "ws_00488fa17f87e9a3",
    ]);
    const selected = options().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.getAttribute("data-workspace-id"))).toEqual([
      "ws_00488fa17f87e9a3",
    ]);
  });

  test("typing narrows the list by name", async () => {
    mounted = await mount({ workspaces: [MINE, HELIX, ACME], activeId: "ws_00488fa17f87e9a3" });
    await openSwitcher();

    await type(switcherInput(), "hel");

    expect(options().map((o) => o.getAttribute("data-workspace-id"))).toEqual([
      "ws_003eba8844413cd9",
    ]);
  });
});

// ---------------------------------------------------------------------------
// (4) Switching
// ---------------------------------------------------------------------------

describe("WorkspaceSwitcher — switching", () => {
  test("picking a workspace fires the setter once and navigates to /w/<slug>/", async () => {
    mounted = await mount({
      workspaces: [MINE, HELIX, ACME],
      activeId: "ws_00488fa17f87e9a3",
      initialPath: "/w/00488fa17f87e9a3/conversations",
    });
    setActiveSpy.mockClear();

    await openSwitcher();
    await click(
      options().find((o) => o.getAttribute("data-workspace-id") === "ws_003eba8844413cd9"),
    );

    expect(setActiveSpy).toHaveBeenCalledTimes(1);
    expect(setActiveSpy.mock.calls[0]?.[0]).toBe("ws_003eba8844413cd9");
    expect(mounted.navigationTarget()).toBe("/w/003eba8844413cd9/");
  });

  test("re-picking the focused workspace opens its overview without firing the setter", async () => {
    mounted = await mount({
      workspaces: [MINE, HELIX],
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/conversations",
    });
    setActiveSpy.mockClear();

    await openSwitcher();
    await click(
      options().find((o) => o.getAttribute("data-workspace-id") === "ws_003eba8844413cd9"),
    );

    expect(setActiveSpy).toHaveBeenCalledTimes(0);
    expect(mounted.navigationTarget()).toBe("/w/003eba8844413cd9/");
  });

  test("opens with nothing highlighted, so the check is the only selected mark", async () => {
    mounted = await mount({ workspaces: [MINE, HELIX, ACME], activeId: "ws_00488fa17f87e9a3" });
    await openSwitcher();

    expect(options().filter((o) => o.hasAttribute("data-highlighted"))).toHaveLength(0);
    expect(switcherInput()?.getAttribute("aria-activedescendant")).toBeNull();
  });

  test("Enter with nothing highlighted switches nowhere", async () => {
    mounted = await mount({ workspaces: [MINE, HELIX, ACME], activeId: "ws_00488fa17f87e9a3" });
    setActiveSpy.mockClear();
    await openSwitcher();

    await press(switcherInput(), "Enter");

    expect(setActiveSpy).toHaveBeenCalledTimes(0);
  });

  test("Enter switches to the highlighted match", async () => {
    mounted = await mount({ workspaces: [MINE, HELIX, ACME], activeId: "ws_00488fa17f87e9a3" });
    setActiveSpy.mockClear();
    await openSwitcher();

    // The first ↓ highlights Acme, the second Helix.
    await press(switcherInput(), "ArrowDown");
    await press(switcherInput(), "ArrowDown");
    await press(switcherInput(), "Enter");

    expect(setActiveSpy.mock.calls[0]?.[0]).toBe("ws_003eba8844413cd9");
    expect(mounted.navigationTarget()).toBe("/w/003eba8844413cd9/");
  });
});

// ---------------------------------------------------------------------------
// (5) Footer actions
// ---------------------------------------------------------------------------

describe("WorkspaceSwitcher — footer", () => {
  test("opens the focused workspace's settings", async () => {
    mounted = await mount({ workspaces: [MINE, HELIX], activeId: "ws_003eba8844413cd9" });
    await openSwitcher();

    const settings = buttons(document.body, "workspace-switcher-settings")[0];
    expect(settings?.textContent).toContain("Helix settings");
    await click(settings);

    expect(mounted.navigationTarget()).toBe("/w/003eba8844413cd9/settings");
  });

  test("New workspace opens the workspaces page", async () => {
    mounted = await mount({ workspaces: [MINE], activeId: "ws_00488fa17f87e9a3" });
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
      activeId: "ws_003eba8844413cd9",
      initialPath: "/w/003eba8844413cd9/",
      placements: [...IDENTITY_PLACEMENTS, appPlacement("people")],
      collapsed: true,
    });

    const nav = byTestId(mounted.container, "sidebar-workspace-nav")[0];
    expect(nav?.getAttribute("data-collapsed")).toBe("true");
    const links = Array.from(nav!.getElementsByTagName("a"));
    expect(links.map((a) => a.getAttribute("aria-label"))).toEqual([
      "Overview",
      "Conversations",
      "Tasks",
      "Files",
      "people",
      "Add apps and tools",
    ]);
    // Icon-only: no visible labels in the rail.
    for (const label of ["Overview", "Conversations", "Apps"]) {
      expect(nav?.textContent).not.toContain(label);
    }
  });
});
