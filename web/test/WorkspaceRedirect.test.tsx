// ---------------------------------------------------------------------------
// WorkspaceRedirect — `/` → `/w/<slug>/` redirect, query/hash passthrough.
//
// Pins the redirect contract:
//   1. Query string survives the redirect — `?force=1` must reach the home
//      route, which `HomeAppRoute` reads. Dropping it kills the force-refresh
//      param for anyone hitting the bare root URL.
//   2. Hash survives the redirect.
//   3. Multiple params survive intact (whole query string, not just `force`).
//   4. No query/hash → clean `/w/<slug>/` with nothing trailing.
//   5. No workspace → redirect to `/settings` instead.
//
// Same plumbing as HomeAppRoute.test.tsx: bun:test + react-dom/client +
// happy-dom (via web/test/setup.ts), no @testing-library/react.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from "bun:test";
import type { WorkspaceInfo } from "../src/context/WorkspaceContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../src/context/WorkspaceContext");
const { WorkspaceRedirect } = await import("../src/App");

const fakeWorkspace: WorkspaceInfo = {
  id: "ws_eng",
  name: "Engineering",
  memberCount: 1,
  bundles: [],
};

// Redirect destination is read from a probe mounted outside <Routes>, so it
// sees the new location regardless of whether a route matches it.
let current: { pathname: string; search: string; hash: string } = {
  pathname: "",
  search: "",
  hash: "",
};
function LocationProbe() {
  const loc = useLocation();
  current = { pathname: loc.pathname, search: loc.search, hash: loc.hash };
  return null;
}

let active: { unmount(): void } | null = null;
afterEach(() => {
  active?.unmount();
  active = null;
  current = { pathname: "", search: "", hash: "" };
});

async function renderAt(url: string, workspaces: WorkspaceInfo[]): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <WorkspaceProvider initialWorkspaces={workspaces}>
          <LocationProbe />
          <Routes>
            <Route path="/" element={<WorkspaceRedirect />} />
          </Routes>
        </WorkspaceProvider>
      </MemoryRouter>,
    );
  });
  // Flush the <Navigate> re-render.
  await act(async () => {
    await Promise.resolve();
  });
  active = {
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

describe("WorkspaceRedirect", () => {
  test("carries ?force=1 through the redirect to the home route", async () => {
    await renderAt("/?force=1", [fakeWorkspace]);
    expect(current.pathname).toBe("/w/eng/");
    expect(current.search).toBe("?force=1");
  });

  test("carries the hash through the redirect", async () => {
    await renderAt("/#section", [fakeWorkspace]);
    expect(current.pathname).toBe("/w/eng/");
    expect(current.hash).toBe("#section");
  });

  test("carries the whole query string, not just force", async () => {
    await renderAt("/?force=1&tab=activity", [fakeWorkspace]);
    expect(current.pathname).toBe("/w/eng/");
    expect(current.search).toBe("?force=1&tab=activity");
  });

  test("no query/hash → clean /w/<slug>/ redirect", async () => {
    await renderAt("/", [fakeWorkspace]);
    expect(current.pathname).toBe("/w/eng/");
    expect(current.search).toBe("");
    expect(current.hash).toBe("");
  });

  test("no workspace → redirect to /settings", async () => {
    await renderAt("/?force=1", []);
    expect(current.pathname).toBe("/settings");
  });
});
