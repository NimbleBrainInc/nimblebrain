// ---------------------------------------------------------------------------
// `/` opens a workspace (ADR-0073): the last one this browser was in while the
// viewer is still a member, else the first in the switcher's order. A viewer in
// no workspace is offered a new one. The error page's way out is the viewer's
// other workspaces, by their own addresses.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { LandingRedirect } = await import("../pages/LandingRedirect");
const { ErrorBoundary } = await import("../components/ErrorBoundary");
const { landingWorkspace } = await import("../lib/last-workspace");

import type { WorkspaceInfo } from "../context/WorkspaceContext";

function ws(id: string, name: string): WorkspaceInfo {
  return { id, name, memberCount: 1, connectorCount: 0, userRole: "admin" };
}

const ALPHA = ws("ws_000f7ed6658f9d30", "Alpha");
const BETA = ws("ws_003eba8844413cd9", "Beta");

let root: ReturnType<typeof ReactDOMClient.createRoot> | null = null;
let container: HTMLDivElement | null = null;
const at = { path: "" };

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  localStorage.clear();
});

function Where() {
  at.path = useLocation().pathname;
  return null;
}

async function land(workspaces: WorkspaceInfo[]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={["/"]}>
        <WorkspaceProvider initialWorkspaces={workspaces}>
          <Where />
          <Routes>
            <Route path="/" element={<LandingRedirect />} />
            <Route path="*" element={null} />
          </Routes>
        </WorkspaceProvider>
      </MemoryRouter>,
    );
  });
}

describe("landingWorkspace", () => {
  test("the last workspace while still a member, else the first in the switcher's order", () => {
    expect(landingWorkspace([ALPHA, BETA], BETA.id)).toBe(BETA);
    expect(landingWorkspace([BETA, ALPHA], "ws_gone")).toBe(ALPHA);
    expect(landingWorkspace([BETA, ALPHA], null)).toBe(ALPHA);
    expect(landingWorkspace([], null)).toBeNull();
  });
});

describe("LandingRedirect — what `/` does", () => {
  test("opens the last workspace this browser was in", async () => {
    localStorage.setItem("nb:last-workspace", JSON.stringify(BETA.id));
    await land([ALPHA, BETA]);
    expect(at.path).toBe("/w/003eba8844413cd9/");
  });

  test("with no last workspace, opens the first in the switcher's order", async () => {
    await land([BETA, ALPHA]);
    expect(at.path).toBe("/w/000f7ed6658f9d30/");
  });

  test("a last workspace the viewer has left is ignored", async () => {
    localStorage.setItem("nb:last-workspace", JSON.stringify("ws_005344c2653be0d6"));
    await land([BETA]);
    expect(at.path).toBe("/w/003eba8844413cd9/");
  });

  test("a viewer in no workspace is offered a new one", async () => {
    await land([]);
    expect(at.path).toBe("/");
    expect(container?.textContent).toContain("You're not in any workspace");
  });
});

describe("ErrorBoundary — the way out of a failed render", () => {
  function Boom(): never {
    throw new Error("render failed");
  }

  test("offers Reload and every other workspace, never the failing one", async () => {
    window.history.pushState({}, "", "/w/003eba8844413cd9/");
    const quiet = console.error;
    console.error = () => {};
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOMClient.createRoot(container);
    await act(async () => {
      root?.render(
        <WorkspaceProvider initialWorkspaces={[ALPHA, BETA]}>
          <ErrorBoundary>
            <Boom />
          </ErrorBoundary>
        </WorkspaceProvider>,
      );
    });
    console.error = quiet;
    const links = Array.from(container.getElementsByTagName("a"));
    expect(links.map((a) => a.textContent)).toEqual(["Reload", "Alpha"]);
    expect(links[1]?.getAttribute("href")).toBe("/w/000f7ed6658f9d30/");
  });
});
