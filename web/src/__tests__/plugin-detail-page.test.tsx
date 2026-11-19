// ---------------------------------------------------------------------------
// PluginDetailPage — one plugin, by whose it is.
//
// A workspace plugin shows the connector's configuration sections, its skills
// and its apps, with Uninstall for a workspace admin only. A person's plugin
// shows the account it signs in as, Use here or Stop using here for this
// workspace, and every workspace it is used in, each revocable. The settings
// page's old address sends a bookmark on to the plugin's page.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";
import type { Plugin } from "../_generated/platform-schemas/plugins";
import type * as ApiClient from "../api/client";
import type { InstalledConnector, PersonalConnector } from "../api/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const WS_ID = "ws_003eba8844413cd9";
const OTHER_WS_ID = "ws_0071a5bbf40116e6";

let plugins: Plugin[] = [];
let personal: PersonalConnector[] = [];

function installed(): InstalledConnector {
  return {
    serverName: "github",
    connectorName: "github",
    displayName: "GitHub",
    disconnectable: true,
    version: "1.0.0",
    state: "running",
    status: "ready",
    scope: "workspace",
    interactive: false,
    toolCount: 1,
    allowedTools: ["search"],
  } as InstalledConnector;
}

const listPlugins = mock<typeof ApiClient.listPlugins>(async (wsId) => ({ wsId, plugins }));
const getInstalledConnector = mock<typeof ApiClient.getInstalledConnector>(async () => ({
  installed: installed(),
}));
const listPersonalConnectors = mock<typeof ApiClient.listPersonalConnectors>(async () => ({
  connectors: personal,
}));
const grantConnector = mock<typeof ApiClient.grantConnector>(async () => {});
const revokeConnector = mock<typeof ApiClient.revokeConnector>(async () => {});
const listConnectorSkills = mock<typeof ApiClient.listConnectorSkills>(async () => ({
  overlays: [
    { server: "github", name: "usage", toolAffinity: ["github__search"] },
    // Another plugin's skill, which this plugin's page leaves out.
    { server: "linear", name: "triage", toolAffinity: ["linear__search"] },
  ],
  published: [],
}));
// Connected without an interactive flow, so Connect stays on the page and the
// test reads which route it took.
const initiateIdentityConnect = mock<typeof ApiClient.initiateIdentityConnect>(
  async () => ({}) as Awaited<ReturnType<typeof ApiClient.initiateIdentityConnect>>,
);
const initiateComposioIdentityConnect = mock<typeof ApiClient.initiateComposioIdentityConnect>(
  async () => ({}) as Awaited<ReturnType<typeof ApiClient.initiateComposioIdentityConnect>>,
);
const disconnectPersonalConnector = mock<typeof ApiClient.disconnectPersonalConnector>(
  async () => ({}) as Awaited<ReturnType<typeof ApiClient.disconnectPersonalConnector>>,
);

mock.module("../api/client", () => ({
  ...realClient,
  listPlugins,
  getInstalledConnector,
  listPersonalConnectors,
  grantConnector,
  revokeConnector,
  listConnectorSkills,
  initiateIdentityConnect,
  initiateComposioIdentityConnect,
  disconnectPersonalConnector,
  listConnectorToolsWithPermissions: async () => ({
    scope: "workspace",
    serverName: "github",
    tools: [{ name: "search", description: "Search." }],
    permissions: {},
  }),
  listWorkspaceSecretKeys: async () => ({ keys: [] }),
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { NoticeProvider } = await import("../components/notices");
const { toSlug } = await import("../lib/workspace-slug");
const { ConnectorPageRedirect, PluginDetailPage } = await import("../pages/PluginDetailPage");

const SLUG = toSlug(WS_ID);

const GITHUB: Plugin = {
  id: "workspace:github",
  displayName: "GitHub",
  owner: { kind: "workspace" },
  granted: true,
  servers: [{ serverName: "github", status: "ready", account: null }],
  skills: [{ name: "usage", kind: "overlay", serverName: "github" }],
  apps: [
    { label: "Issues", serverName: "github", resourceUri: "ui://github/issues", route: "issues" },
  ],
};

function granola(granted: boolean): Plugin {
  return {
    id: "person:granola",
    displayName: "Granola",
    owner: { kind: "person" },
    granted,
    servers: [{ serverName: "granola", status: "ready", account: { email: "pat@acme.test" } }],
    skills: [],
    apps: [],
  };
}

function granolaConnector(grantedWorkspaces: string[]): PersonalConnector {
  return {
    serverName: "granola",
    displayName: "Granola",
    description: null,
    state: "running",
    auth: "dcr",
    identity: { email: "pat@acme.test" },
    grantedWorkspaces,
  };
}

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
let location = "";
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

beforeEach(() => {
  plugins = [];
  personal = [];
  location = "";
  for (const m of [
    listPlugins,
    listPersonalConnectors,
    grantConnector,
    revokeConnector,
    initiateIdentityConnect,
    initiateComposioIdentityConnect,
    disconnectPersonalConnector,
  ]) {
    m.mockClear();
  }
  listPersonalConnectors.mockImplementation(async () => ({ connectors: personal }));
  disconnectPersonalConnector.mockImplementation(
    async () => ({}) as Awaited<ReturnType<typeof ApiClient.disconnectPersonalConnector>>,
  );
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function Where() {
  location = useLocation().pathname;
  return null;
}

async function mount(path: string, role: "admin" | "member" = "admin"): Promise<Mounted> {
  const workspaces = [
    { id: WS_ID, name: "Helix", memberCount: 2, connectorCount: 0, userRole: role },
    { id: OTHER_WS_ID, name: "Orbit", memberCount: 2, connectorCount: 0, userRole: role },
  ];
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <NoticeProvider>
        <WorkspaceProvider initialWorkspaces={workspaces} initialActiveId={WS_ID}>
          <MemoryRouter initialEntries={[path]}>
            <Where />
            <Routes>
              <Route path="/w/:slug/plugins" element={<p>Plugins list</p>} />
              <Route path="/w/:slug/plugins/:pluginRef" element={<PluginDetailPage />} />
              <Route
                path="/w/:slug/settings/connectors/:serverName"
                element={<ConnectorPageRedirect />}
              />
            </Routes>
          </MemoryRouter>
        </WorkspaceProvider>
      </NoticeProvider>,
    );
  });
  await settle();
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const pagePath = (id: string) => `/w/${SLUG}/plugins/${encodeURIComponent(id)}`;

function button(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

function testId(scope: ParentNode, id: string): HTMLElement | null {
  return scope.querySelector(`[data-testid="${id}"]`);
}

/** Open the connector's ⋯ menu and read what it offers. */
async function menuItems(container: HTMLElement): Promise<string[]> {
  await click(container.querySelector('[aria-label="GitHub options"]'));
  return [...document.body.querySelectorAll('[role="menuitem"]')].map(
    (el) => el.textContent?.trim() ?? "",
  );
}

describe("PluginDetailPage — a workspace plugin", () => {
  test("shows the connector's sections, its skills, whose account it uses and its apps", async () => {
    plugins = [GITHUB];
    mounted = await mount(pagePath(GITHUB.id));
    const text = mounted.container.textContent ?? "";

    expect(getInstalledConnector).toHaveBeenCalledWith("github");
    expect(mounted.container.querySelector("h1")?.textContent).toBe("GitHub");
    expect(testId(mounted.container, "plugin-owner")?.textContent).toBe(
      "Uses the workspace's account",
    );
    const app = testId(mounted.container, "plugin-apps")?.querySelector("a");
    expect(app?.textContent).toBe("Issues");
    expect(app?.getAttribute("href")).toBe(`/w/${SLUG}/app/issues`);
    // The plugin's own skills, read for this workspace.
    expect(listConnectorSkills).toHaveBeenCalledWith(WS_ID);
    expect(text).toContain("usage");
    expect(text).not.toContain("triage");
    expect(text).toContain("Tool permissions");
  });

  test("a workspace admin may uninstall it", async () => {
    plugins = [GITHUB];
    mounted = await mount(pagePath(GITHUB.id), "admin");
    expect(await menuItems(mounted.container)).toContain("Uninstall…");
  });

  test("a member sees it without Uninstall", async () => {
    plugins = [GITHUB];
    mounted = await mount(pagePath(GITHUB.id), "member");
    expect(mounted.container.textContent).toContain("Tool permissions");
    expect(await menuItems(mounted.container)).not.toContain("Uninstall…");
  });

  test("an id the listing does not hold says so", async () => {
    plugins = [GITHUB];
    mounted = await mount(pagePath("workspace:linear"));
    expect(mounted.container.textContent).toContain(
      "This plugin is not installed in this workspace.",
    );
    expect(getInstalledConnector).not.toHaveBeenCalledWith("linear");
  });
});

describe("PluginDetailPage — a person's plugin", () => {
  test("shows the account it signs in as, and that it uses yours", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    expect(testId(mounted.container, "plugin-status")?.textContent).toBe(
      "Connected as pat@acme.test",
    );
    expect(testId(mounted.container, "plugin-owner")?.textContent).toBe("Uses your account");
  });

  test("Use here grants it here only after the confirm", async () => {
    plugins = [granola(false)];
    personal = [granolaConnector([])];
    mounted = await mount(pagePath("person:granola"));

    await click(button(testId(mounted.container, "plugin-here")!, "Use here"));
    expect(grantConnector).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Use Granola (pat@acme.test) in Helix?");
    expect(document.body.textContent).toContain("Only you can use it here; other members can't.");

    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    await click(button(document.body.querySelector('[role="dialog"]')!, "Use here"));
    expect(grantConnector).toHaveBeenCalledWith("granola", WS_ID);
    expect(button(testId(mounted.container, "plugin-here")!, "Stop using here")).toBeDefined();
  });

  test("Stop using here revokes it in this workspace", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    await click(button(testId(mounted.container, "plugin-here")!, "Stop using here"));
    expect(revokeConnector).toHaveBeenCalledWith("granola", WS_ID);
  });

  test("Used in lists every workspace it is granted to, each revocable", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID, OTHER_WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    const rows = [...mounted.container.querySelectorAll('[data-testid="plugin-used-in-row"]')];
    expect(rows.map((r) => r.querySelector("a")?.textContent)).toEqual(["Helix", "Orbit"]);

    await click(rows[1]?.querySelector('[aria-label="Stop using Granola in Orbit"]'));
    expect(revokeConnector).toHaveBeenCalledWith("granola", OTHER_WS_ID);
    expect(revokeConnector).not.toHaveBeenCalledWith("granola", WS_ID);
  });

  test("Used in says so when it is on nowhere", async () => {
    plugins = [granola(false)];
    personal = [granolaConnector([])];
    mounted = await mount(pagePath("person:granola"));
    expect(testId(mounted.container, "plugin-used-in")?.textContent).toContain(
      "Not on in any workspace.",
    );
  });

  test("a sign-in that is not ready offers Connect", async () => {
    plugins = [
      {
        ...granola(false),
        servers: [{ serverName: "granola", status: "not_connected", account: null }],
      },
    ];
    personal = [{ ...granolaConnector([]), state: "not_authenticated", identity: undefined }];
    mounted = await mount(pagePath("person:granola"));
    expect(testId(mounted.container, "plugin-status")?.textContent).toBe("Not connected");
    expect(button(mounted.container, "Connect")).toBeDefined();
  });

  test("Connect waits for the connector record, then takes its route", async () => {
    plugins = [
      {
        ...granola(false),
        servers: [{ serverName: "granola", status: "not_connected", account: null }],
      },
    ];
    let resolve: (v: { connectors: PersonalConnector[] }) => void = () => {};
    listPersonalConnectors.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    mounted = await mount(pagePath("person:granola"));

    const connect = button(mounted.container, "Connect");
    expect(connect?.disabled).toBe(true);
    await click(connect);
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
    expect(initiateComposioIdentityConnect).not.toHaveBeenCalled();

    await act(async () => {
      resolve({
        connectors: [
          {
            ...granolaConnector([]),
            state: "not_authenticated",
            identity: undefined,
            auth: "composio",
            connectorId: "ai.granola/granola",
          },
        ],
      });
    });
    await settle();
    await click(button(mounted.container, "Connect"));
    expect(initiateComposioIdentityConnect).toHaveBeenCalledWith("ai.granola/granola");
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
  });

  test("Connect on a DCR connector keys on the server name", async () => {
    plugins = [
      {
        ...granola(false),
        servers: [{ serverName: "granola", status: "not_connected", account: null }],
      },
    ];
    personal = [{ ...granolaConnector([]), state: "not_authenticated", identity: undefined }];
    mounted = await mount(pagePath("person:granola"));
    await click(button(mounted.container, "Connect"));
    expect(initiateIdentityConnect).toHaveBeenCalledWith("granola");
    expect(initiateComposioIdentityConnect).not.toHaveBeenCalled();
  });

  test("Disconnect asks first, and Cancel leaves it connected", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    await click(button(mounted.container, "Disconnect"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Disconnect Granola?");
    expect(dialog.textContent).toContain("It turns off in the 1 workspace it is on in.");

    await click(button(dialog, "Cancel"));
    expect(disconnectPersonalConnector).not.toHaveBeenCalled();
    expect(location).toBe(pagePath("person:granola"));
  });

  test("Disconnect removes it and returns to Plugins", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    await click(button(mounted.container, "Disconnect"));
    await click(button(document.body.querySelector('[role="dialog"]')!, "Disconnect"));
    expect(disconnectPersonalConnector).toHaveBeenCalledWith("granola");
    expect(location).toBe(`/w/${SLUG}/plugins`);
  });

  test("a failed Disconnect stays on the page and says why", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    disconnectPersonalConnector.mockImplementation(async () => {
      throw new Error("Sign-out failed");
    });
    mounted = await mount(pagePath("person:granola"));
    await click(button(mounted.container, "Disconnect"));
    await click(button(document.body.querySelector('[role="dialog"]')!, "Disconnect"));
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(
      "Sign-out failed",
    );
    expect(location).toBe(pagePath("person:granola"));
  });
});

describe("the settings page's old address", () => {
  test("sends a workspace connector on to its plugin's page", async () => {
    plugins = [granola(true), GITHUB];
    mounted = await mount(`/w/${SLUG}/settings/connectors/github`);
    expect(location).toBe(pagePath(GITHUB.id));
  });

  test("never sends it to a person's plugin of the same server", async () => {
    plugins = [{ ...granola(true), id: "person:github", servers: GITHUB.servers }];
    mounted = await mount(`/w/${SLUG}/settings/connectors/github`);
    expect(location).toBe(`/w/${SLUG}/plugins`);
  });
});
