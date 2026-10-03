// ---------------------------------------------------------------------------
// `/` — where a user lands when the URL names no workspace (ADR-0044).
//
// Pins:
//   1. A user in exactly one workspace goes straight into it.
//   2. A user in several sees every one of them, and is taken into none.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";
import type { WorkspaceInfo } from "../context/WorkspaceContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
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

async function land(workspaces: WorkspaceInfo[]): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <WorkspaceProvider initialWorkspaces={workspaces}>
          <Routes>
            <Route path="/" element={<GlobalHomePage />} />
            <Route path="/w/:slug/*" element={null} />
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
});

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
