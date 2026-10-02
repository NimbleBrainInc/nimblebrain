// ---------------------------------------------------------------------------
// Mobile nav drawer — a navigation closes it (SidebarContext owns the rule).
//
// Pins:
//   1. With the drawer open, any navigation closes it: a programmatic route
//      change, a WorkspaceNav link, a tap on the page already open (a same-URL
//      replace), and a search-only change.
//   2. The drawer does not close on the provider's first render.
//   3. Switching workspaces in the tree keeps it open (KEEP_DRAWER_OPEN): the
//      switch expands the new workspace's views for the user to pick from.
//      Re-selecting the focused workspace opens its overview and closes it,
//      and so does going back or forward to a switch's history entry.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mockedActiveId: string | null = null;

mock.module("../api/client", () => ({
  ...realClient,
  setActiveWorkspaceId: (id: string | null) => {
    mockedActiveId = id;
  },
  getActiveWorkspaceId: (): string | null => mockedActiveId,
  callTool: mock(async () => ({ structuredContent: null, content: [] })),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation, useNavigate } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { ShellProvider } = await import("../context/ShellContext");
const { WorkspaceAppIconsContext } = await import("../context/WorkspaceAppIconsContext");
const { SidebarProvider, useSidebar } = await import("../context/SidebarContext");
const { WorkspaceNav } = await import("../components/shell/WorkspaceNav");

import type { NavigateFunction } from "react-router-dom";
import type { WorkspaceInfo } from "../context/WorkspaceContext";
import type { PlacementEntry } from "../types";

interface Probe {
  isDrawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  navigate: NavigateFunction;
  path: string;
}

const probe: Probe = {
  isDrawerOpen: false,
  setDrawerOpen: () => {},
  navigate: () => {},
  path: "",
};

// Reads the drawer state and the location on every render. With
// `openOnMount`, opens the drawer from a child effect, which runs before the
// provider's own effects on the first commit: a route watch that fired on
// mount would close it again.
function DrawerProbe({ openOnMount }: { openOnMount: boolean }) {
  const { isDrawerOpen, setDrawerOpen } = useSidebar();
  const location = useLocation();
  probe.isDrawerOpen = isDrawerOpen;
  probe.setDrawerOpen = setDrawerOpen;
  probe.navigate = useNavigate();
  probe.path = `${location.pathname}${location.search}`;
  React.useEffect(() => {
    if (openOnMount) setDrawerOpen(true);
  }, []);
  return null;
}

const WORKSPACES: WorkspaceInfo[] = [
  {
    id: "ws_team",
    name: "Team",
    connectorCount: 0,
    memberCount: 2,
    userRole: "admin",
  },
  {
    id: "ws_other",
    name: "Other",
    connectorCount: 0,
    memberCount: 2,
    userRole: "admin",
  },
];

const PLACEMENTS: PlacementEntry[] = [
  {
    serverName: "conversations",
    slot: "sidebar",
    resourceUri: "ui://conversations/main",
    priority: 1,
    label: "Conversations",
    route: "conversations",
  },
];

const forSlot = (slot: string): PlacementEntry[] =>
  PLACEMENTS.filter((p) => p.slot === slot || p.slot.startsWith(`${slot}.`));

let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function mount({
  initialPath,
  openOnMount = false,
}: {
  initialPath: string;
  openOnMount?: boolean;
}): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root!.render(
      <React.StrictMode>
        <MemoryRouter initialEntries={[initialPath]}>
          <WorkspaceProvider initialWorkspaces={WORKSPACES} initialActiveId="ws_team">
            <SidebarProvider>
              <DrawerProbe openOnMount={openOnMount} />
              <WorkspaceAppIconsContext.Provider value={{ iconFor: () => undefined }}>
                <ShellProvider
                  value={{ forSlot, mainRoutes: () => [], shellWorkspaceId: "ws_team" }}
                >
                  <Routes>
                    <Route path="*" element={<WorkspaceNav />} />
                  </Routes>
                </ShellProvider>
              </WorkspaceAppIconsContext.Provider>
            </SidebarProvider>
          </WorkspaceProvider>
        </MemoryRouter>
      </React.StrictMode>,
    );
  });
  return container;
}

async function openDrawer() {
  await act(async () => probe.setDrawerOpen(true));
  expect(probe.isDrawerOpen).toBe(true);
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
}

function linkTo(root: HTMLElement, href: string): HTMLElement {
  const link = Array.from(root.getElementsByTagName("a")).find(
    (a) => a.getAttribute("href") === href,
  );
  if (!link) throw new Error(`no link to ${href}`);
  return link;
}

function workspaceHeader(root: HTMLElement, id: string): HTMLElement {
  const header = Array.from(root.getElementsByTagName("button")).find(
    (b) =>
      b.getAttribute("data-testid") === "sidebar-workspace-header" &&
      b.getAttribute("data-workspace-id") === id,
  );
  if (!header) throw new Error(`no header for ${id}`);
  return header;
}

// The drawer exists only below the md breakpoint, and SidebarProvider closes
// it on a wider viewport. happy-dom's default viewport is 1024px wide.
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  mockedActiveId = null;
  window.matchMedia = ((query: string) => {
    const mq = realMatchMedia.call(window, query);
    return Object.defineProperty(mq, "matches", { value: false });
  }) as typeof window.matchMedia;
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("mobile drawer — a navigation closes it", () => {
  test("a route change closes the open drawer", async () => {
    await mount({ initialPath: "/w/team/" });
    await openDrawer();

    await act(async () => probe.navigate("/w/team/automations"));

    expect(probe.path).toBe("/w/team/automations");
    expect(probe.isDrawerOpen).toBe(false);
  });

  test("a WorkspaceNav link closes the open drawer", async () => {
    const c = await mount({ initialPath: "/w/team/" });
    await openDrawer();

    await click(linkTo(c, "/w/team/conversations"));

    expect(probe.path).toBe("/w/team/conversations");
    expect(probe.isDrawerOpen).toBe(false);
  });

  test("tapping the page already open closes the drawer", async () => {
    const c = await mount({ initialPath: "/w/team/conversations" });
    await openDrawer();

    await click(linkTo(c, "/w/team/conversations"));

    expect(probe.path).toBe("/w/team/conversations");
    expect(probe.isDrawerOpen).toBe(false);
  });

  test("a search-only change closes the drawer", async () => {
    await mount({ initialPath: "/w/team/notifications?item=a" });
    await openDrawer();

    await act(async () => probe.navigate("/w/team/notifications"));

    expect(probe.isDrawerOpen).toBe(false);
  });

  test("re-selecting the focused workspace opens its overview and closes the drawer", async () => {
    const c = await mount({ initialPath: "/w/team/conversations" });
    await openDrawer();

    await click(workspaceHeader(c, "ws_team"));

    expect(probe.path).toBe("/w/team/");
    expect(probe.isDrawerOpen).toBe(false);
  });

  test("going back to a workspace switch closes the drawer", async () => {
    const c = await mount({ initialPath: "/w/team/" });
    await openDrawer();
    await click(workspaceHeader(c, "ws_other"));
    await click(linkTo(c, "/w/other/conversations"));
    await openDrawer();

    // The switch's history entry still carries KEEP_DRAWER_OPEN.
    await act(async () => probe.navigate(-1));

    expect(probe.path).toBe("/w/other/");
    expect(probe.isDrawerOpen).toBe(false);
  });
});

describe("mobile drawer — what leaves it open", () => {
  test("the first render does not close it", async () => {
    await mount({ initialPath: "/w/team/", openOnMount: true });

    expect(probe.isDrawerOpen).toBe(true);
  });

  test("switching workspaces in the tree keeps it open on the new workspace", async () => {
    const c = await mount({ initialPath: "/w/team/" });
    await openDrawer();

    await click(workspaceHeader(c, "ws_other"));

    expect(probe.path).toBe("/w/other/");
    expect(probe.isDrawerOpen).toBe(true);
  });
});
