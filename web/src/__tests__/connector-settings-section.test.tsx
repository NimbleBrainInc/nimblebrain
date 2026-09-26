// ---------------------------------------------------------------------------
// A connector's settings component on its settings page.
//
// Pins the contract of the `settings` placement slot:
//
//   1. The page renders the connector's first `settings` placement by priority,
//      after the host's sections, and nothing when there is none. A second
//      placement for the same connector, and another connector's, are ignored.
//   2. Every member who reaches the page sees it; `canManage` is not a
//      visibility gate.
//   3. The component is told whether the viewer can manage the connector, as
//      `hostContext.connector.canManage`: true for a workspace admin, false for
//      a member and for an org admin who is not a workspace admin (the write
//      rule has no org-admin bypass). It reaches the handshake, and a role change
//      reaches a mounted iframe through `host-context-changed`.
//   4. Other mounts carry no `connector` key.
//
// Same plumbing as SlotRenderer.test.tsx: whole-module mock over the api/client
// snapshot from web/test/setup.ts. The iframe's window is stubbed so the test
// plays the app's side of the handshake against the real bridge.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type { InstalledConnector } from "../api/client";
import type { WorkspaceInfo } from "../context/WorkspaceContext";
import type { PlacementEntry } from "../types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SERVER = "crm";

function installed(): InstalledConnector {
  return {
    serverName: SERVER,
    connectorName: SERVER,
    version: "1.0.0",
    state: "running",
    status: "ready",
    scope: "workspace",
    interactive: true,
    toolCount: 0,
    catalog: {
      id: "com.example/crm",
      name: "Acme CRM",
      description: "",
      iconUrl: "",
      url: "https://crm.example.test/mcp",
      auth: "dcr",
    },
  } as InstalledConnector;
}

const getResources = mock(async (_app: string, path: string) => ({
  html: `<p data-path="${path}">settings</p>`,
}));

mock.module("../api/client", () => ({
  ...realClient,
  getResources,
  getInstalledConnector: async () => ({ installed: installed() }),
  listConnectorToolsWithPermissions: async () => ({
    scope: "workspace",
    serverName: SERVER,
    tools: [],
    permissions: {},
  }),
  listWorkspaceSecretKeys: async () => ({ keys: [] }),
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");
const { ThemeProvider } = await import("../context/ThemeContext");
const { ShellProvider } = await import("../context/ShellContext");
const { WorkspaceProvider, useWorkspaceContext } = await import("../context/WorkspaceContext");
const { SessionProvider } = await import("../context/SessionContext");
const { ConnectorDetailPage } = await import("../pages/settings/ConnectorDetailPage");
const { WorkspaceSettingsPage } = await import("../pages/settings/WorkspaceSettingsPage");
const { SlotRenderer } = await import("../components/SlotRenderer");
const { buildHostContext, buildHostExtensions } = await import("../bridge/host-extensions");

// ── Fixtures ────────────────────────────────────────────────────────

function workspace(userRole?: "admin" | "member"): WorkspaceInfo {
  return {
    id: "ws_team",
    name: "Team",
    memberCount: 3,
    connectors: [],
    ...(userRole ? { userRole } : {}),
  };
}

function placement(over: Partial<PlacementEntry>): PlacementEntry {
  return {
    serverName: SERVER,
    slot: "settings",
    resourceUri: `ui://${SERVER}/settings`,
    priority: 100,
    ...over,
  } as PlacementEntry;
}

/** The shell's `forSlot`: prefix match, sorted by priority (see `useShell`). */
function forSlotOver(placements: PlacementEntry[]) {
  return (slot: string) =>
    placements
      .filter((p) => p.slot === slot || p.slot.startsWith(`${slot}.`))
      .sort((a, b) => a.priority - b.priority);
}

// ── Mount ───────────────────────────────────────────────────────────

let setWorkspace: ((ws: WorkspaceInfo) => void) | null = null;
function CaptureSetter() {
  setWorkspace = useWorkspaceContext().setActiveWorkspace;
  return null;
}

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
beforeEach(() => {
  getResources.mockClear();
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  setWorkspace = null;
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(element: React.ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await settle();
  mounted = {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
  return mounted;
}

async function mountPage(
  ws: WorkspaceInfo,
  placements: PlacementEntry[],
  { shellWorkspaceId = ws.id, orgRole = "member" } = {},
): Promise<Mounted> {
  return render(
    <ThemeProvider>
      <SessionProvider
        session={{
          authenticated: true,
          user: { id: "u1", email: "u@example.test", displayName: "U", orgRole },
        }}
      >
        <WorkspaceProvider initialWorkspaces={[ws]} initialActiveId={ws.id}>
          <CaptureSetter />
          <ShellProvider
            value={{ forSlot: forSlotOver(placements), mainRoutes: () => [], shellWorkspaceId }}
          >
            <MemoryRouter initialEntries={[`/w/team/settings/connectors/${SERVER}`]}>
              <Routes>
                <Route
                  path="/w/:slug/settings/connectors/:serverName"
                  element={<ConnectorDetailPage />}
                />
              </Routes>
            </MemoryRouter>
          </ShellProvider>
        </WorkspaceProvider>
      </SessionProvider>
    </ThemeProvider>,
  );
}

// ── The app's side of the bridge ────────────────────────────────────

interface AppSide {
  inbox: Array<Record<string, unknown>>;
  send(data: unknown): void;
}

/** Stand in for the app inside the one iframe in `container`. */
function appSide(container: HTMLElement): AppSide {
  const iframes = container.getElementsByTagName("iframe");
  expect(iframes.length).toBe(1);
  const iframe = iframes[0] as HTMLIFrameElement;
  const inbox: Array<Record<string, unknown>> = [];
  const stubWindow = {
    postMessage(data: Record<string, unknown>) {
      inbox.push(data);
    },
  } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, get: () => stubWindow });
  return {
    inbox,
    send(data: unknown) {
      const event = new window.MessageEvent("message", { data });
      Object.defineProperty(event, "source", { configurable: true, get: () => stubWindow });
      window.dispatchEvent(event);
    },
  };
}

async function handshake(app: AppSide): Promise<Record<string, unknown>> {
  await act(async () => {
    app.send({
      jsonrpc: "2.0",
      id: "init",
      method: "ui/initialize",
      params: {
        protocolVersion: "2026-01-26",
        clientInfo: { name: "iframe", version: "1.0.0" },
        capabilities: {},
      },
    });
  });
  const reply = app.inbox.find((m) => m.id === "init") as {
    result: { hostContext: Record<string, unknown> };
  };
  expect(reply).toBeDefined();
  await act(async () => {
    app.send({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  });
  return reply.result.hostContext;
}

function lastHostContextChange(app: AppSide): Record<string, unknown> | undefined {
  const pushes = app.inbox.filter((m) => m.method === "ui/notifications/host-context-changed");
  return pushes.at(-1)?.params as Record<string, unknown> | undefined;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("ConnectorDetailPage — the connector's settings section", () => {
  test("renders the connector's settings placement, headed by its name and attributed", async () => {
    const { container } = await mountPage(workspace("admin"), [placement({})]);

    expect(getResources).toHaveBeenCalledWith(SERVER, `${SERVER}/settings`);
    expect(container.getElementsByTagName("iframe").length).toBe(1);
    const headings = Array.from(container.getElementsByTagName("h2")).map((h) => h.textContent);
    expect(headings).toContain("Acme CRM");
    expect(container.textContent).toContain(`Provided by ${SERVER}`);
  });

  test("renders after the host's sections", async () => {
    const { container } = await mountPage(workspace("admin"), [placement({})]);

    // happy-dom's selector parser rejects `closest("section")`; walk up instead.
    let section: HTMLElement | null = container.getElementsByTagName("iframe")[0] ?? null;
    while (section && section.tagName !== "SECTION") section = section.parentElement;
    const sections = Array.from(container.getElementsByTagName("section"));
    expect(section).toBeTruthy();
    expect(sections.at(-1)).toBe(section as HTMLElement);
  });

  test("renders nothing when the connector declares no settings placement", async () => {
    const { container } = await mountPage(workspace("admin"), [
      placement({ slot: "sidebar.apps", resourceUri: `ui://${SERVER}/main`, route: "crm" }),
      placement({ serverName: "other", resourceUri: "ui://other/settings" }),
      // A slot the contract does not define is not a settings section.
      placement({ slot: "settings.extra", resourceUri: `ui://${SERVER}/extra` }),
    ]);

    expect(getResources).not.toHaveBeenCalled();
    expect(container.getElementsByTagName("iframe").length).toBe(0);
    expect(container.textContent).not.toContain("Provided by");
  });

  test("renders the first by priority and ignores a second", async () => {
    const { container } = await mountPage(workspace("admin"), [
      placement({ resourceUri: `ui://${SERVER}/later`, priority: 50 }),
      placement({ resourceUri: `ui://${SERVER}/first`, priority: 10 }),
    ]);

    expect(getResources).toHaveBeenCalledTimes(1);
    expect(getResources).toHaveBeenCalledWith(SERVER, `${SERVER}/first`);
    expect(container.getElementsByTagName("iframe").length).toBe(1);
  });

  test("renders nothing while the shell still holds another workspace's placements", async () => {
    const { container } = await mountPage(workspace("admin"), [placement({})], {
      shellWorkspaceId: "ws_previous",
    });

    expect(container.getElementsByTagName("iframe").length).toBe(0);
  });

  test("renders for a member who cannot manage the connector", async () => {
    const { container } = await mountPage(workspace("member"), [placement({})]);

    // The host's own admin affordance is gated...
    expect(container.textContent).not.toContain("Uninstall");
    // ...the connector's section is not.
    expect(container.getElementsByTagName("iframe").length).toBe(1);
  });
});

describe("ConnectorDetailPage — the manage flag", () => {
  test("is true for a workspace admin", async () => {
    const { container } = await mountPage(workspace("admin"), [placement({})]);
    const ctx = await handshake(appSide(container));
    expect(ctx.connector).toEqual({ canManage: true });
  });

  test("is false for a workspace member", async () => {
    const { container } = await mountPage(workspace("member"), [placement({})]);
    const ctx = await handshake(appSide(container));
    expect(ctx.connector).toEqual({ canManage: false });
  });

  test("is false for an org admin who is not a workspace admin", async () => {
    // An org admin reaches any workspace's settings, but the write rule reads
    // workspace membership only.
    for (const role of ["member", undefined] as const) {
      const { container } = await mountPage(workspace(role), [placement({})], { orgRole: "admin" });
      const ctx = await handshake(appSide(container));
      expect(ctx.connector).toEqual({ canManage: false });
      mounted?.unmount();
      mounted = null;
    }
  });

  test("a role change reaches the mounted iframe without remounting it", async () => {
    const { container } = await mountPage(workspace("member"), [placement({})]);
    const app = appSide(container);
    expect((await handshake(app)).connector).toEqual({ canManage: false });

    await act(async () => {
      setWorkspace?.(workspace("admin"));
    });
    await settle();

    const pushed = lastHostContextChange(app);
    expect(pushed?.connector).toEqual({ canManage: true });
    // The workspace extension rides the same live push.
    expect(pushed?.workspace).toMatchObject({ id: "ws_team" });
    expect(getResources).toHaveBeenCalledTimes(1);
  });
});

describe("SlotRenderer — canManage", () => {
  test("a change to canManage alone is pushed to the mounted iframe", async () => {
    let setCanManage: ((v: boolean) => void) | null = null;
    function Harness() {
      const [canManage, set] = React.useState(false);
      setCanManage = set;
      return <SlotRenderer placements={[placement({})]} canManage={canManage} fitContent />;
    }
    const { container } = await render(
      <ThemeProvider>
        <WorkspaceProvider initialWorkspaces={[workspace("admin")]} initialActiveId="ws_team">
          <Harness />
        </WorkspaceProvider>
      </ThemeProvider>,
    );
    const app = appSide(container);
    expect((await handshake(app)).connector).toEqual({ canManage: false });

    await act(async () => {
      setCanManage?.(true);
    });
    await settle();

    expect(lastHostContextChange(app)?.connector).toEqual({ canManage: true });
    expect(getResources).toHaveBeenCalledTimes(1);
  });

  test("fitContent sizes the iframe to the height its content reports", async () => {
    const { container } = await render(
      <ThemeProvider>
        <WorkspaceProvider initialWorkspaces={[workspace("admin")]} initialActiveId="ws_team">
          <SlotRenderer placements={[placement({})]} canManage={false} fitContent />
        </WorkspaceProvider>
      </ThemeProvider>,
    );
    const iframe = container.getElementsByTagName("iframe")[0] as HTMLIFrameElement;
    const app = appSide(container);
    await handshake(app);

    await act(async () => {
      app.send({
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height: 432 },
      });
    });
    expect(iframe.style.height).toBe("432px");

    // A report from a root that has not rendered yet keeps the current height.
    await act(async () => {
      app.send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 0 } });
    });
    expect(iframe.style.height).toBe("432px");
  });
});

describe("host context for other placements", () => {
  test("a SlotRenderer without canManage sends no connector key, at handshake or live", async () => {
    const { container } = await render(
      <ThemeProvider>
        <WorkspaceProvider initialWorkspaces={[workspace("admin")]} initialActiveId="ws_team">
          <CaptureSetter />
          <SlotRenderer
            placements={[placement({ slot: "sidebar.apps", resourceUri: `ui://${SERVER}/main` })]}
          />
        </WorkspaceProvider>
      </ThemeProvider>,
    );
    const app = appSide(container);
    const ctx = await handshake(app);
    expect(ctx).not.toHaveProperty("connector");
    expect(ctx.workspace).toMatchObject({ id: "ws_team" });

    await act(async () => {
      setWorkspace?.({ ...workspace("admin"), name: "Renamed" });
    });
    await settle();
    const pushed = lastHostContextChange(app);
    expect(pushed?.workspace).toMatchObject({ name: "Renamed" });
    expect(pushed).not.toHaveProperty("connector");
  });

  test("the builders add `connector` only when it is supplied", () => {
    const ws = { id: "ws_team", name: "Team" };
    expect(buildHostExtensions(ws)).toEqual({
      workspace: { id: "ws_team", name: "Team", isPersonal: false },
    });
    expect(buildHostExtensions(ws, { canManage: false })).toEqual({
      workspace: { id: "ws_team", name: "Team", isPersonal: false },
      connector: { canManage: false },
    });
    expect(buildHostContext("light", ws)).not.toHaveProperty("connector");
    expect(buildHostContext("dark", ws, { canManage: true }).connector).toEqual({
      canManage: true,
    });
  });
});

describe("workspace settings navigation", () => {
  test("has no Apps tab, and a settings placement adds no nav entry", async () => {
    const ws = workspace("admin");
    const { container } = await render(
      <SessionProvider
        session={{
          authenticated: true,
          user: { id: "u1", email: "u@example.test", displayName: "U" },
        }}
      >
        <WorkspaceProvider initialWorkspaces={[ws]} initialActiveId={ws.id}>
          <ShellProvider
            value={{
              forSlot: forSlotOver([placement({ label: "CRM settings" })]),
              mainRoutes: () => [],
              shellWorkspaceId: ws.id,
            }}
          >
            <MemoryRouter initialEntries={["/w/team/settings/general"]}>
              <Routes>
                <Route path="/w/:slug/settings/*" element={<WorkspaceSettingsPage />} />
              </Routes>
            </MemoryRouter>
          </ShellProvider>
        </WorkspaceProvider>
      </SessionProvider>,
    );

    const links = Array.from(container.getElementsByTagName("a"));
    const labels = links.map((a) => a.textContent?.trim());
    expect(labels).toContain("Connectors");
    expect(labels).not.toContain("Apps");
    expect(labels).not.toContain("CRM settings");
    expect(links.some((a) => a.getAttribute("href")?.includes("/settings/apps"))).toBe(false);
  });
});
