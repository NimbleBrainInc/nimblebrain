// ---------------------------------------------------------------------------
// WorkspaceRouteGuard — single-source-of-truth invariant.
//
// The URL slug is authoritative for the active workspace; the wire
// workspace (`X-Workspace-Id`, from the ambient `activeWorkspaceId`) is a
// projection of it. The load-bearing contract: a workspace-scoped child
// must NOT mount until the ambient workspace equals the route — otherwise
// a descendant's data fetch reads the stale ambient value (the bootstrap
// personal default, or the previous route's workspace) and shows one
// workspace's data under another workspace's URL.
//
// The probe child records `getActiveWorkspaceId()` on every render. The
// regression we're pinning: the child must never observe the personal
// default while sitting under `/w/<shared-slug>/...` — it should only ever
// see the route's workspace. Same plumbing as workspace-section.test.tsx
// (bun:test + react-dom/client + happy-dom via web/test/setup.ts).
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mirror the api/client setter's equality guard so the mocked ambient id
// tracks exactly what production would send on the wire.
let mockedActiveId: string | null = null;
const setActiveSpy = mock((id: string | null) => {
  if (mockedActiveId === id) return;
  mockedActiveId = id;
});
const mockedGetActiveWorkspaceId = (): string | null => mockedActiveId;

mock.module("../api/client", () => ({
  ...realClient,
  setActiveWorkspaceId: setActiveSpy,
  getActiveWorkspaceId: mockedGetActiveWorkspaceId,
  callTool: mock(async () => ({ structuredContent: null, content: [] })),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { WorkspaceRouteGuard } = await import("../components/WorkspaceRouteGuard");
const { getActiveWorkspaceId } = await import("../api/client");

import type { WorkspaceInfo } from "../context/WorkspaceContext";

const PERSONAL = "ws_user_user_p";
// Multi-underscore semantic id mirrors the real shared workspace that
// surfaced the bug (`ws_nimblebrain_shared` → slug `nimblebrain_shared`).
const SHARED = "ws_nimblebrain_shared";
const SHARED_SLUG = "nimblebrain_shared";

function ws(overrides: Partial<WorkspaceInfo> & { id: string; name: string }): WorkspaceInfo {
  return {
    id: overrides.id,
    name: overrides.name,
    bundles: [],
    memberCount: 1,
    isPersonal: overrides.isPersonal ?? false,
    userRole: overrides.userRole ?? "admin",
    ...overrides,
  };
}

// Records the ambient workspace id the child sees on every render, so we
// can assert it never observed the stale (personal) default.
let observedByChild: (string | null)[] = [];
function ProbeChild() {
  observedByChild.push(getActiveWorkspaceId());
  return <div data-testid="probe">workspace child</div>;
}

let navTarget = "/";
function NavigationProbe() {
  navTarget = useLocation().pathname;
  return null;
}

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}
let mounted: Mounted | null = null;

async function mount({
  workspaces,
  activeId,
  initialPath,
}: {
  workspaces: WorkspaceInfo[];
  activeId?: string;
  initialPath: string;
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
            <Routes>
              <Route path="/" element={<div data-testid="home" />} />
              <Route path="/w/:slug" element={<WorkspaceRouteGuard />}>
                <Route path="probe" element={<ProbeChild />} />
              </Route>
            </Routes>
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
  };
}

beforeEach(() => {
  mockedActiveId = null;
  setActiveSpy.mockClear();
  observedByChild = [];
  navTarget = "/";
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function hasTestId(container: HTMLElement, testid: string): boolean {
  return Array.from(container.getElementsByTagName("*")).some(
    (el) => el.getAttribute("data-testid") === testid,
  );
}

describe("WorkspaceRouteGuard — workspace single-source-of-truth", () => {
  test("child never observes the stale (personal) ambient workspace under a shared-workspace URL", async () => {
    // Bootstrap defaults the ambient workspace to personal, but the URL
    // names the shared workspace — the exact post-OAuth-redirect setup.
    mounted = await mount({
      workspaces: [
        ws({ id: PERSONAL, name: "Personal", isPersonal: true }),
        ws({ id: SHARED, name: "NimbleBrain Shared" }),
      ],
      activeId: PERSONAL,
      initialPath: `/w/${SHARED_SLUG}/probe`,
    });

    // The child mounted (gate eventually opened)…
    expect(hasTestId(mounted.container, "probe")).toBe(true);
    // …and every value it ever observed was the route's workspace — it
    // NEVER saw the personal default. Pre-fix, the child's first render
    // observed PERSONAL (the bug: personal connectors under the shared URL).
    expect(observedByChild.length).toBeGreaterThan(0);
    expect(observedByChild.every((id) => id === SHARED)).toBe(true);
    expect(observedByChild).not.toContain(PERSONAL);
    // Ambient is reconciled to the route on the wire.
    expect(getActiveWorkspaceId()).toBe(SHARED);
  });

  test("already-aligned ambient workspace renders the child immediately", async () => {
    mounted = await mount({
      workspaces: [
        ws({ id: PERSONAL, name: "Personal", isPersonal: true }),
        ws({ id: SHARED, name: "NimbleBrain Shared" }),
      ],
      activeId: SHARED,
      initialPath: `/w/${SHARED_SLUG}/probe`,
    });
    expect(hasTestId(mounted.container, "probe")).toBe(true);
    expect(observedByChild.every((id) => id === SHARED)).toBe(true);
  });

  test("unknown / non-member slug bounces home and never mounts the child", async () => {
    mounted = await mount({
      workspaces: [ws({ id: PERSONAL, name: "Personal", isPersonal: true })],
      activeId: PERSONAL,
      initialPath: "/w/ws_not_a_member/probe",
    });
    expect(hasTestId(mounted.container, "probe")).toBe(false);
    expect(navTarget).toBe("/");
  });
});
