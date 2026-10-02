// ---------------------------------------------------------------------------
// Mobile nav drawer — a navigation closes it (SidebarContext owns the rule).
//
// Pins:
//   1. With the drawer open, any navigation closes it: a programmatic route
//      change, a WorkspaceNav link, a tap on the page already open (a same-URL
//      replace), a search-only change, and a workspace switch (which lands on
//      the new workspace's overview).
//   2. The drawer does not close on the provider's first render.
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
const { WorkspaceSwitcher } = await import("../components/shell/WorkspaceSwitcher");

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
    id: "ws_0071a5bbf40116e6",
    name: "Team",
    connectorCount: 0,
    memberCount: 2,
    userRole: "admin",
  },
  {
    id: "ws_005820c54ca342ad",
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
          <WorkspaceProvider initialWorkspaces={WORKSPACES} initialActiveId="ws_0071a5bbf40116e6">
            <SidebarProvider>
              <DrawerProbe openOnMount={openOnMount} />
              <WorkspaceAppIconsContext.Provider value={{ iconFor: () => undefined }}>
                <ShellProvider
                  value={{ forSlot, mainRoutes: () => [], shellWorkspaceId: "ws_0071a5bbf40116e6" }}
                >
                  <Routes>
                    <Route
                      path="*"
                      element={
                        <>
                          <WorkspaceSwitcher />
                          <WorkspaceNav />
                        </>
                      }
                    />
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

// Open the switcher and pick a workspace. The list renders in a portal, so it
// is found on the document, not under the mount.
async function switchTo(root: HTMLElement, id: string) {
  await click(buttonBy(root, (b) => b.dataset.testid === "workspace-switcher-trigger"));
  await click(
    buttonBy(
      document.body,
      (b) => b.dataset.testid === "workspace-switcher-option" && b.dataset.workspaceId === id,
    ),
  );
}

function buttonBy(root: HTMLElement, match: (b: HTMLElement) => boolean): HTMLElement {
  const button = Array.from(root.getElementsByTagName("button")).find(match);
  if (!button) throw new Error("no matching button");
  return button;
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
    await mount({ initialPath: "/w/0071a5bbf40116e6/" });
    await openDrawer();

    await act(async () => probe.navigate("/w/0071a5bbf40116e6/automations"));

    expect(probe.path).toBe("/w/0071a5bbf40116e6/automations");
    expect(probe.isDrawerOpen).toBe(false);
  });

  test("a WorkspaceNav link closes the open drawer", async () => {
    const c = await mount({ initialPath: "/w/0071a5bbf40116e6/" });
    await openDrawer();

    await click(linkTo(c, "/w/0071a5bbf40116e6/conversations"));

    expect(probe.path).toBe("/w/0071a5bbf40116e6/conversations");
    expect(probe.isDrawerOpen).toBe(false);
  });

  test("tapping the page already open closes the drawer", async () => {
    const c = await mount({ initialPath: "/w/0071a5bbf40116e6/conversations" });
    await openDrawer();

    await click(linkTo(c, "/w/0071a5bbf40116e6/conversations"));

    expect(probe.path).toBe("/w/0071a5bbf40116e6/conversations");
    expect(probe.isDrawerOpen).toBe(false);
  });

  test("a search-only change closes the drawer", async () => {
    await mount({ initialPath: "/w/0071a5bbf40116e6/notifications?item=a" });
    await openDrawer();

    await act(async () => probe.navigate("/w/0071a5bbf40116e6/notifications"));

    expect(probe.isDrawerOpen).toBe(false);
  });

  test("switching workspaces lands on the new overview and closes the drawer", async () => {
    const c = await mount({ initialPath: "/w/0071a5bbf40116e6/conversations" });
    await openDrawer();

    await switchTo(c, "ws_005820c54ca342ad");

    expect(probe.path).toBe("/w/005820c54ca342ad/");
    expect(probe.isDrawerOpen).toBe(false);
  });

  test("going back closes the drawer", async () => {
    const c = await mount({ initialPath: "/w/0071a5bbf40116e6/" });
    await click(linkTo(c, "/w/0071a5bbf40116e6/conversations"));
    await openDrawer();

    await act(async () => probe.navigate(-1));

    expect(probe.path).toBe("/w/0071a5bbf40116e6/");
    expect(probe.isDrawerOpen).toBe(false);
  });
});

describe("mobile drawer — what leaves it open", () => {
  test("the first render does not close it", async () => {
    await mount({ initialPath: "/w/0071a5bbf40116e6/", openOnMount: true });

    expect(probe.isDrawerOpen).toBe(true);
  });
});
