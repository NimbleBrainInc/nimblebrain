// ---------------------------------------------------------------------------
// TourProvider — the tour as the shell runs it.
//
// Pins:
//   1. A first visit to a workspace's Overview offers the tour; a browser that
//      has seen it is not offered it again.
//   2. Skip and Done remember the tour as seen and end it.
//   3. Next opens the page the coming step belongs on (Browse plugins, then
//      Skills), and Done returns to Overview.
//   4. Help's replay starts it from any page, and on a phone closes the
//      sidebar drawer, which would otherwise cover the page the tour points at.
//   5. `useTourRunning` is true only while the tour is on screen, so the
//      telemetry question waits its turn.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "./happy-dom";
import { realClient } from "./setup";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

mock.module("../src/api/client", () => ({
  ...realClient,
  setActiveWorkspaceId: () => {},
  getActiveWorkspaceId: () => null,
}));

const captured: string[] = [];
mock.module("../src/telemetry", () => ({
  captureEvent: (name: string) => {
    captured.push(name);
  },
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../src/context/WorkspaceContext");
const { SidebarProvider, useSidebar } = await import("../src/context/SidebarContext");
const { TourProvider, useTour, useTourRunning } = await import("../src/components/tour/ShellTour");

import type { WorkspaceInfo } from "../src/context/WorkspaceContext";

const WS_ID = "ws_0071a5bbf40116e6";
const BASE = "/w/0071a5bbf40116e6";
const WORKSPACES: WorkspaceInfo[] = [
  { id: WS_ID, name: "Team", connectorCount: 0, memberCount: 1, userRole: "admin" },
];

const probe = {
  path: "",
  running: false,
  drawerOpen: false,
  setDrawerOpen: (_open: boolean) => {},
  start: () => {},
};

function Probe() {
  const location = useLocation();
  const sidebar = useSidebar();
  probe.path = location.pathname + location.search;
  probe.running = useTourRunning();
  probe.drawerOpen = sidebar.isDrawerOpen;
  probe.setDrawerOpen = sidebar.setDrawerOpen;
  probe.start = useTour().start;
  return null;
}

// Each page renders the anchors its steps point at.
function Pages() {
  return (
    <Routes>
      <Route
        path="/w/:slug/"
        element={
          <>
            <div data-tour="nav">nav</div>
            <div data-tour="apps">apps</div>
            <div data-tour="ask">
              <input aria-label="Ask" />
            </div>
          </>
        }
      />
      <Route path="/w/:slug/plugins/browse" element={<div data-tour="catalog" />} />
      <Route path="/w/:slug/skills" element={<div data-tour="skills" />} />
      <Route path="*" element={<div>elsewhere</div>} />
    </Routes>
  );
}

let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function mount(initialPath: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <WorkspaceProvider initialWorkspaces={WORKSPACES} initialActiveId={WS_ID}>
          <SidebarProvider>
            <TourProvider>
              <Probe />
              <Pages />
            </TourProvider>
          </SidebarProvider>
        </WorkspaceProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

/** Lets animation frames, Joyride's target wait, and React commits run. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

const card = () => document.querySelector<HTMLElement>('[data-testid="tour-card"]');
const cardTitle = () => card()?.querySelector("p")?.textContent ?? null;

async function press(testid: "tour-next" | "tour-skip") {
  const button = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  if (!button) throw new Error(`no ${testid} button`);
  await act(async () => button.click());
  await settle();
}

const realMatchMedia = window.matchMedia;
const realInnerWidth = window.innerWidth;

function phone() {
  window.innerWidth = 375;
  window.matchMedia = ((query: string) => {
    const mq = realMatchMedia.call(window, query);
    return Object.defineProperty(mq, "matches", { value: query.startsWith("(max-width") });
  }) as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  captured.length = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.matchMedia = realMatchMedia;
  window.innerWidth = realInnerWidth;
  localStorage.clear();
});

describe("offering the tour", () => {
  test("a first visit to Overview offers it, and the telemetry question waits", async () => {
    await mount(`${BASE}/`);

    expect(cardTitle()).toBe("Welcome to NimbleBrain");
    expect(probe.running).toBe(true);
    expect(captured).toEqual(["web.tour_started"]);
  });

  test("a browser that has seen it is not offered it", async () => {
    localStorage.setItem("nb:tour-seen", "true");
    await mount(`${BASE}/`);

    expect(card()).toBeNull();
    expect(probe.running).toBe(false);
  });

  test("it is not offered off Overview", async () => {
    await mount(`${BASE}/tasks`);

    expect(card()).toBeNull();
  });
});

describe("ending the tour", () => {
  test("Skip ends it and remembers it as seen", async () => {
    await mount(`${BASE}/`);
    await press("tour-skip");

    expect(card()).toBeNull();
    expect(probe.running).toBe(false);
    expect(localStorage.getItem("nb:tour-seen")).toBe("true");
    expect(captured).toContain("web.tour_skipped");
  });

  test("Next walks Browse plugins for the catalog and Skills for skills, and Done returns to Overview", async () => {
    await mount(`${BASE}/`);

    const visited: Array<[string | null, string]> = [];
    for (let i = 0; i < 5; i++) {
      await press("tour-next");
      visited.push([cardTitle(), probe.path]);
    }
    expect(visited).toEqual([
      ["Your workspace", `${BASE}/`],
      ["Your apps", `${BASE}/`],
      ["Browse plugins", `${BASE}/plugins/browse`],
      ["Teach it with skills", `${BASE}/skills`],
      ["Ask your first question", `${BASE}/`],
    ]);

    await press("tour-next");
    expect(card()).toBeNull();
    expect(probe.running).toBe(false);
    expect(localStorage.getItem("nb:tour-seen")).toBe("true");
    expect(captured).toContain("web.tour_finished");
  });
});

describe("replaying from Help", () => {
  test("starts it from any page, even once seen", async () => {
    localStorage.setItem("nb:tour-seen", "true");
    await mount(`${BASE}/tasks`);

    await act(async () => probe.start());
    await settle();

    expect(cardTitle()).toBe("Welcome to NimbleBrain");
    expect(probe.running).toBe(true);
  });

  test("on a phone, closes the sidebar drawer the Help menu sits in", async () => {
    localStorage.setItem("nb:tour-seen", "true");
    phone();
    await mount(`${BASE}/`);
    await act(async () => probe.setDrawerOpen(true));
    expect(probe.drawerOpen).toBe(true);

    await act(async () => probe.start());
    await settle();
    expect(probe.drawerOpen).toBe(false);

    // The first stop on a phone is Apps, on the Overview already open.
    await press("tour-next");
    expect(cardTitle()).toBe("Your apps");
    expect(probe.drawerOpen).toBe(false);
  });
});
