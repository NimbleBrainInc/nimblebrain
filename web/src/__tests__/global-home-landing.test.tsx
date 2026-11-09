// ---------------------------------------------------------------------------
// `/` — where a user lands when the URL names no workspace (ADR-0044).
//
// Pins:
//   1. A user in exactly one workspace goes straight into it.
//   2. A user in several sees every one of them, and is taken into none.
//   3. A default workspace opens when the page loads at `/` (ADR-0060), and
//      only then: not on a link to `/` from inside the app, not at `/?home`,
//      and not once the viewer is no longer a member of it.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";
import type { WorkspaceInfo } from "../context/WorkspaceContext";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Navigate, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { GlobalHomePage } = await import("../pages/GlobalHomePage");

function ws(id: string, name: string): WorkspaceInfo {
  return { id, name, memberCount: 1, connectorCount: 0, userRole: "admin" };
}

let path = "";
function WhereAmI() {
  path = useLocation().pathname;
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

async function land(workspaces: WorkspaceInfo[], at = "/"): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[at]}>
        <WorkspaceProvider initialWorkspaces={workspaces}>
          <Routes>
            <Route path="/" element={<GlobalHomePage />} />
            <Route path="/w/:slug/*" element={null} />
            {/* A link to `/` from inside the app, after the page has loaded. */}
            <Route path="/elsewhere" element={<Navigate to="/" />} />
          </Routes>
          <WhereAmI />
        </WorkspaceProvider>
      </MemoryRouter>,
    );
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  path = "";
  localStorage.clear();
});

const A = ws("ws_00a1b2c3d4e5f607", "Alpha");
const B = ws("ws_00f7e6d5c4b3a291", "Beta");

function chooseDefault(id: string): void {
  localStorage.setItem("nb:default-workspace", JSON.stringify(id));
}

describe("landing at /", () => {
  test("a user in one workspace goes straight into it", async () => {
    await land([ws("ws_00a1b2c3d4e5f607", "Only")]);
    expect(path).toBe("/w/00a1b2c3d4e5f607/");
  });

  test("a user in several sees them all and is taken into none", async () => {
    await land([ws("ws_00a1b2c3d4e5f607", "Home"), ws("ws_00f7e6d5c4b3a291", "Other")]);
    expect(path).toBe("/");
    const tiles = container.querySelectorAll('[data-testid="home-workspace-tile"]');
    expect(tiles.length).toBe(2);
  });
});

describe("a default workspace", () => {
  test("opens when the page loads at /", async () => {
    chooseDefault(B.id);
    await land([A, B]);
    expect(path).toBe("/w/00f7e6d5c4b3a291/");
  });

  test("does not open on a link to / from inside the app", async () => {
    chooseDefault(B.id);
    await land([A, B], "/elsewhere");
    expect(path).toBe("/");
  });

  test("does not open at /?home", async () => {
    chooseDefault(B.id);
    await land([A, B], "/?home");
    expect(path).toBe("/");
  });

  test("is ignored once the viewer is not a member of it", async () => {
    chooseDefault("ws_00ffffffffffffff");
    await land([A, B]);
    expect(path).toBe("/");
  });

  test("is chosen from a tile, one at a time, and cleared from the same tile", async () => {
    await land([A, B], "/?home");
    const toggle = (id: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-testid="home-workspace-default"][data-workspace-id="${id}"]`,
      );
    await act(async () => toggle(A.id)?.click());
    expect(localStorage.getItem("nb:default-workspace")).toBe(JSON.stringify(A.id));
    await act(async () => toggle(B.id)?.click());
    expect(localStorage.getItem("nb:default-workspace")).toBe(JSON.stringify(B.id));
    expect(toggle(A.id)?.getAttribute("aria-pressed")).toBe("false");
    expect(toggle(B.id)?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => toggle(B.id)?.click());
    expect(localStorage.getItem("nb:default-workspace")).toBeNull();
  });
});
