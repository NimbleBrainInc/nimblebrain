// ---------------------------------------------------------------------------
// PluginDetailPage — one plugin, by whose it is.
//
// A workspace plugin shows the connector's configuration sections, its skills
// and its apps, with Sign out and Remove for a workspace admin only. A person's plugin
// shows the account it signs in as, Use here or Stop using here for this
// workspace, and every workspace the person belongs to, each on or off with
// the change that flips it. The settings
// page's old address sends a bookmark on to the plugin's page.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";
import type { Plugin } from "../_generated/platform-schemas/plugins";
import type * as ApiClient from "../api/client";
import type { InstalledConnector, PersonalConnector } from "../api/client";
import { __internal__ as eventsClient } from "../api/events-client";
import type { ConnectEventsOptions, EventConnection } from "../api/sse";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const WS_ID = "ws_003eba8844413cd9";
const OTHER_WS_ID = "ws_0071a5bbf40116e6";
const THIRD_WS_ID = "ws_00c1d2e3f4a5b6c7";

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
const signOutPersonalConnector = mock<typeof ApiClient.signOutPersonalConnector>(
  async () => ({}) as Awaited<ReturnType<typeof ApiClient.signOutPersonalConnector>>,
);
const removePersonalConnector = mock<typeof ApiClient.removePersonalConnector>(
  async () => ({}) as Awaited<ReturnType<typeof ApiClient.removePersonalConnector>>,
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
  signOutPersonalConnector,
  removePersonalConnector,
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
const { NoticeProvider, NoticeViewport } = await import("../components/notices");
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
    signOutPersonalConnector,
    removePersonalConnector,
  ]) {
    m.mockClear();
  }
  listPersonalConnectors.mockImplementation(async () => ({ connectors: personal }));
  signOutPersonalConnector.mockImplementation(
    async () => ({}) as Awaited<ReturnType<typeof ApiClient.signOutPersonalConnector>>,
  );
  removePersonalConnector.mockImplementation(
    async () => ({}) as Awaited<ReturnType<typeof ApiClient.removePersonalConnector>>,
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
    { id: THIRD_WS_ID, name: "Quarry", memberCount: 1, connectorCount: 0, userRole: role },
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
        <NoticeViewport />
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

const pagePath = (id: string, slug = SLUG) => `/w/${slug}/plugins/${encodeURIComponent(id)}`;

function button(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

/** Every button's label on the page, trimmed. */
function buttonLabels(scope: ParentNode): string[] {
  return [...scope.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");
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

/** Each workspace row's name, whether it is marked as this one, and its state. */
function workspaceRows(scope: ParentNode): { name: string; current: boolean; state: string }[] {
  return [...scope.querySelectorAll('[data-testid="plugin-workspace-row"]')].map((r) => ({
    name: r.querySelector("a")?.textContent ?? "",
    current: testId(r, "plugin-workspace-current") !== null,
    state: testId(r, "plugin-workspace-state")?.textContent ?? "",
  }));
}

function row(scope: ParentNode, name: string): HTMLElement {
  const found = [
    ...scope.querySelectorAll<HTMLElement>('[data-testid="plugin-workspace-row"]'),
  ].find((r) => r.querySelector("a")?.textContent === name);
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');

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

  test("a workspace admin may remove it", async () => {
    plugins = [GITHUB];
    mounted = await mount(pagePath(GITHUB.id), "admin");
    expect(await menuItems(mounted.container)).toContain("Remove…");
  });

  test("a member sees it without Remove", async () => {
    plugins = [GITHUB];
    mounted = await mount(pagePath(GITHUB.id), "member");
    expect(mounted.container.textContent).toContain("Tool permissions");
    expect(await menuItems(mounted.container)).not.toContain("Remove…");
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

  test("Stop using here revokes it in this workspace after the same confirm as the row menu's", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    await click(button(testId(mounted.container, "plugin-here")!, "Stop using here"));
    expect(revokeConnector).not.toHaveBeenCalled();
    const confirm = document.body.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(confirm.textContent).toContain("Stop using Granola here?");
    expect(confirm.textContent).toContain(
      "Your agent can't use it in Helix until you turn it back on. It stays connected to your account.",
    );
    await click(button(confirm, "Stop using here"));
    expect(revokeConnector).toHaveBeenCalledWith("granola", WS_ID);
  });

  test("cancelling the Stop using confirm changes nothing", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    await click(button(testId(mounted.container, "plugin-here")!, "Stop using here"));
    await click(button(document.body.querySelector('[role="dialog"]')!, "Cancel"));
    expect(revokeConnector).not.toHaveBeenCalled();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  test("Workspaces lists every workspace the person belongs to, each with its state", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID, THIRD_WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    expect(workspaceRows(mounted.container)).toEqual([
      { name: "Helix", current: true, state: "On" },
      { name: "Orbit", current: false, state: "Off" },
      { name: "Quarry", current: false, state: "On" },
    ]);
    const orbit = row(mounted.container, "Orbit");
    expect(button(orbit, "Use in Orbit")?.getAttribute("aria-label")).toBe("Use Granola in Orbit");
    expect(orbit.querySelector('[aria-label="Stop using Granola in Orbit"]')).toBeNull();
    expect(
      row(mounted.container, "Quarry").querySelector('[aria-label="Stop using Granola in Quarry"]'),
    ).not.toBeNull();
  });

  test("the workspace the page is in comes first", async () => {
    plugins = [granola(false)];
    personal = [granolaConnector([])];
    mounted = await mount(pagePath("person:granola", toSlug(THIRD_WS_ID)));
    expect(workspaceRows(mounted.container).map((r) => [r.name, r.current])).toEqual([
      ["Quarry", true],
      ["Helix", false],
      ["Orbit", false],
    ]);
  });

  test("Use in grants that workspace only after the confirm, and says so", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    mounted = await mount(pagePath("person:granola"));

    await click(button(row(mounted.container, "Orbit"), "Use in Orbit"));
    expect(grantConnector).not.toHaveBeenCalled();
    const confirm = dialog()!;
    expect(confirm.textContent).toContain("Use Granola (pat@acme.test) in Orbit?");
    expect(confirm.textContent).toContain(
      "Only you can use it in Orbit; other members can't. What your agent does with it is saved in Orbit",
    );

    personal = [granolaConnector([WS_ID, OTHER_WS_ID])];
    await click(button(confirm, "Use in Orbit"));
    expect(grantConnector).toHaveBeenCalledTimes(1);
    expect(grantConnector).toHaveBeenCalledWith("granola", OTHER_WS_ID);
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
    expect(row(mounted.container, "Orbit").dataset.on).toBe("true");
    expect(document.body.textContent).toContain("Granola is on in Orbit");
  });

  test("Stop using revokes that workspace only after the confirm", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID, OTHER_WS_ID])];
    mounted = await mount(pagePath("person:granola"));

    await click(
      row(mounted.container, "Orbit").querySelector('[aria-label="Stop using Granola in Orbit"]'),
    );
    expect(revokeConnector).not.toHaveBeenCalled();
    const confirm = dialog()!;
    expect(confirm.textContent).toContain("Stop using Granola in Orbit?");

    personal = [granolaConnector([WS_ID])];
    await click(button(confirm, "Stop using"));
    expect(revokeConnector).toHaveBeenCalledTimes(1);
    expect(revokeConnector).toHaveBeenCalledWith("granola", OTHER_WS_ID);
    expect(row(mounted.container, "Orbit").dataset.on).toBe("false");
    expect(document.body.textContent).toContain("Granola is off in Orbit");
  });

  test("a change that fails puts the row back and says why", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    grantConnector.mockImplementationOnce(async () => {
      throw new Error("Grant refused");
    });
    mounted = await mount(pagePath("person:granola"));

    await click(button(row(mounted.container, "Orbit"), "Use in Orbit"));
    await click(button(dialog()!, "Use in Orbit"));
    expect(grantConnector).toHaveBeenCalledWith("granola", OTHER_WS_ID);
    expect(row(mounted.container, "Orbit").dataset.on).toBe("false");
    expect(button(row(mounted.container, "Orbit"), "Use in Orbit")?.disabled).toBe(false);
    expect(document.body.textContent).toContain("Couldn't turn Granola on in Orbit");
    expect(document.body.textContent).toContain("Grant refused");
  });

  test("a plugin that is not signed in still turns on elsewhere, and the row says so", async () => {
    plugins = [
      {
        ...granola(false),
        servers: [{ serverName: "granola", status: "not_connected", account: null }],
      },
    ];
    personal = [{ ...granolaConnector([]), state: "not_authenticated", identity: undefined }];
    mounted = await mount(pagePath("person:granola"));

    await click(button(row(mounted.container, "Orbit"), "Use in Orbit"));
    expect(dialog()?.textContent).toContain("It won't work there until you sign in to Granola.");
    personal = [
      { ...granolaConnector([OTHER_WS_ID]), state: "not_authenticated", identity: undefined },
    ];
    await click(button(dialog()!, "Use in Orbit"));
    expect(grantConnector).toHaveBeenCalledWith("granola", OTHER_WS_ID);
    // Only the grant: signing in stays a step the person takes.
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
    expect(testId(row(mounted.container, "Orbit"), "plugin-workspace-state")?.textContent).toBe(
      "On · Not signed in",
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
    expect(testId(mounted.container, "plugin-status")?.textContent).toBe("Not signed in");
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
    // Named with the workspace it is pressed in, so the sign-in returns to its Plugins page.
    expect(initiateComposioIdentityConnect).toHaveBeenCalledWith("ai.granola/granola", WS_ID);
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
    expect(initiateIdentityConnect).toHaveBeenCalledWith("granola", WS_ID);
    expect(initiateComposioIdentityConnect).not.toHaveBeenCalled();
  });

  test("on here and connected reads In use here, with Stop using here beside it", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    const here = testId(mounted.container, "plugin-here")!;
    expect(testId(here, "plugin-in-use")?.textContent).toBe("In use here");
    expect(button(here, "Stop using here")).toBeDefined();
    expect(button(here, "Use here")).toBeUndefined();
  });

  test("on here but not signed in says to connect, and offers no In use here", async () => {
    plugins = [
      {
        ...granola(true),
        servers: [{ serverName: "granola", status: "not_connected", account: null }],
      },
    ];
    personal = [{ ...granolaConnector([WS_ID]), state: "not_authenticated", identity: undefined }];
    mounted = await mount(pagePath("person:granola"));
    const here = testId(mounted.container, "plugin-here")!;
    expect(here.textContent).toContain("Connect to sign in to Granola");
    expect(testId(here, "plugin-in-use")).toBeNull();
    expect(button(mounted.container, "Connect")).toBeDefined();
    expect(button(here, "Stop using here")).toBeDefined();
  });

  test("Use here on a plugin with no sign-in turns it on, then signs in back to Plugins", async () => {
    plugins = [
      {
        ...granola(false),
        servers: [{ serverName: "granola", status: "not_connected", account: null }],
      },
    ];
    personal = [{ ...granolaConnector([]), state: "not_authenticated", identity: undefined }];
    mounted = await mount(pagePath("person:granola"));

    await click(button(testId(mounted.container, "plugin-here")!, "Use here"));
    expect(document.body.textContent).toContain("You'll sign in to Granola next.");
    await click(button(document.body.querySelector('[role="dialog"]')!, "Use here"));

    expect(grantConnector).toHaveBeenCalledWith("granola", WS_ID);
    expect(initiateIdentityConnect).toHaveBeenCalledWith("granola", WS_ID);
    expect(grantConnector.mock.invocationCallOrder[0]).toBeLessThan(
      initiateIdentityConnect.mock.invocationCallOrder[0]!,
    );
  });

  test("Sign out asks first, says the plugin stays, and Cancel leaves it signed in", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    await click(button(mounted.container, "Sign out"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Sign out of Granola?");
    expect(dialog.textContent).toContain(
      "Granola stays in your account and on in every workspace it is on in. The agent can't use it until you sign in again.",
    );

    await click(button(dialog, "Cancel"));
    expect(signOutPersonalConnector).not.toHaveBeenCalled();
    expect(removePersonalConnector).not.toHaveBeenCalled();
  });

  test("Sign out keeps it on the page, reading Not signed in with Connect", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    signOutPersonalConnector.mockImplementation(async (serverName) => {
      plugins = [
        {
          ...granola(true),
          servers: [{ serverName: "granola", status: "not_connected", account: null }],
        },
      ];
      personal = [
        { ...granolaConnector([WS_ID]), state: "not_authenticated", identity: undefined },
      ];
      return { ok: true, scope: "identity", serverName };
    });
    mounted = await mount(pagePath("person:granola"));
    await click(button(mounted.container, "Sign out"));
    await click(button(document.body.querySelector('[role="dialog"]')!, "Sign out"));
    await settle();

    expect(signOutPersonalConnector).toHaveBeenCalledWith("granola");
    expect(removePersonalConnector).not.toHaveBeenCalled();
    expect(location).toBe(pagePath("person:granola"));
    expect(testId(mounted.container, "plugin-status")?.textContent).toBe("Not signed in");
    expect(buttonLabels(mounted.container)).toContain("Connect");
    // Nothing left to sign out of; Remove still is.
    expect(buttonLabels(mounted.container)).not.toContain("Sign out");
    expect(buttonLabels(mounted.container)).toContain("Remove");
  });

  test("Remove asks first, naming the workspaces it turns off in, and Cancel leaves it", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    await click(button(mounted.container, "Remove"));
    const dialog = document.body.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Remove Granola?");
    expect(dialog.textContent).toContain("It turns off in the 1 workspace it is on in.");

    await click(button(dialog, "Cancel"));
    expect(removePersonalConnector).not.toHaveBeenCalled();
    expect(location).toBe(pagePath("person:granola"));
  });

  test("Remove removes it and returns to Plugins", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    mounted = await mount(pagePath("person:granola"));
    await click(button(mounted.container, "Remove"));
    await click(button(document.body.querySelector('[role="dialog"]')!, "Remove"));
    expect(removePersonalConnector).toHaveBeenCalledWith("granola");
    expect(signOutPersonalConnector).not.toHaveBeenCalled();
    expect(location).toBe(`/w/${SLUG}/plugins`);
  });

  test("a failed Remove stays on the page and says why", async () => {
    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID])];
    removePersonalConnector.mockImplementation(async () => {
      throw new Error("Remove failed");
    });
    mounted = await mount(pagePath("person:granola"));
    await click(button(mounted.container, "Remove"));
    await click(button(document.body.querySelector('[role="dialog"]')!, "Remove"));
    expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("Remove failed");
    expect(location).toBe(pagePath("person:granola"));
  });
});

describe("PluginDetailPage — a grant changed elsewhere", () => {
  // The events stream is driven through the real events-client singleton's
  // `setConnectorForTest` seam, as chat-plugins-provider.test.tsx does.
  let events: ConnectEventsOptions | null = null;
  beforeEach(() => {
    events = null;
    eventsClient.resetForTest();
    eventsClient.setConnectorForTest((options) => {
      events = options;
      return { close() {} } satisfies EventConnection;
    });
  });
  afterEach(() => {
    eventsClient.resetForTest();
    eventsClient.setConnectorForTest(null);
  });

  test("re-reads the plugin and its connector record, so here and Workspaces both update", async () => {
    plugins = [granola(false)];
    personal = [granolaConnector([])];
    mounted = await mount(pagePath("person:granola"));
    expect(workspaceRows(mounted.container).map((r) => r.state)).toEqual(["Off", "Off", "Off"]);
    const listings = listPlugins.mock.calls.length;
    const records = listPersonalConnectors.mock.calls.length;

    plugins = [granola(true)];
    personal = [granolaConnector([WS_ID, OTHER_WS_ID])];
    await act(async () => {
      events?.onEvent("connector.grant_changed", {
        userId: "usr_pat",
        serverName: "granola",
        wsId: OTHER_WS_ID,
        granted: true,
      });
    });
    await settle();

    expect(listPlugins.mock.calls.length).toBe(listings + 1);
    expect(listPersonalConnectors.mock.calls.length).toBe(records + 1);
    expect(workspaceRows(mounted.container).map((r) => r.state)).toEqual(["On", "On", "Off"]);
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
