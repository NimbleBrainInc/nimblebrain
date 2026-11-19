// ---------------------------------------------------------------------------
// PluginsPage — what the agent can do in a workspace.
//
// Installed lists what the agent can use here in one group and the viewer's
// plugins not used here in another. A row names the account it uses, offers
// only what needs the viewer (Connect, Use here), keeps the rest in its ⋯
// menu, and opens the plugin's page. Browse is the connector
// directory, whose install actions only a member who may write the workspace
// sees. Use here is the viewer's own grant, so any member gets it.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";
import type { Plugin } from "../_generated/platform-schemas/plugins";
import type * as ApiClient from "../api/client";
import type { PersonalConnector } from "../api/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const WS_ID = "ws_003eba8844413cd9";

let plugins: Plugin[] = [];

const listPlugins = mock<typeof ApiClient.listPlugins>(async (wsId) => ({ wsId, plugins }));
const grantConnector = mock<typeof ApiClient.grantConnector>(async () => {});
const revokeConnector = mock<typeof ApiClient.revokeConnector>(async () => {});
const disconnectPersonalConnector = mock<typeof ApiClient.disconnectPersonalConnector>(
  async (serverName) => ({ ok: true, scope: "identity", serverName, revokedWorkspaces: 0 }),
);
let personal: PersonalConnector[] = [];
const listPersonalConnectors = mock<typeof ApiClient.listPersonalConnectors>(async () => ({
  connectors: personal,
}));
// Connected without an interactive flow, so the page stays put and the test
// reads which route the sign-in took.
const initiateIdentityConnect = mock<typeof ApiClient.initiateIdentityConnect>(async () => ({
  authorizationUrl: null,
}));
const initiateComposioIdentityConnect = mock<typeof ApiClient.initiateComposioIdentityConnect>(
  async () => ({}) as Awaited<ReturnType<typeof ApiClient.initiateComposioIdentityConnect>>,
);
const listDirectory = mock(async () => ({
  entries: [
    {
      id: "com.acme/tasks",
      name: "Acme Tasks",
      description: "Acme Tasks tools",
      install: {
        kind: "remote-oauth" as const,
        url: "https://tasks.acme.test/mcp",
        transportType: "streamable-http" as const,
        auth: "provider" as const,
        providerAuth: { provider: "minted", config: {} },
      },
    },
  ],
  errors: [],
}));
const getInstalledConnectors = mock(async () => ({ installed: [] }));
// The Installed tab's Skills group lists skills; this suite is about plugins.
const callTool = mock<typeof ApiClient.callTool>(async () => ({
  content: [],
  structuredContent: { skills: [] },
  isError: false,
}));

mock.module("../api/client", () => ({
  ...realClient,
  callTool,
  listPlugins,
  grantConnector,
  revokeConnector,
  disconnectPersonalConnector,
  listPersonalConnectors,
  initiateIdentityConnect,
  initiateComposioIdentityConnect,
  listDirectory,
  getInstalledConnectors,
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { toSlug } = await import("../lib/workspace-slug");
const { PluginsPage } = await import("../pages/PluginsPage");
const { NoticeProvider } = await import("../components/notices");

const SLUG = toSlug(WS_ID);

function plugin(over: Partial<Plugin> & Pick<Plugin, "id" | "displayName" | "owner">): Plugin {
  const serverName = over.id.split(":")[1] ?? over.id;
  return {
    granted: true,
    servers: [{ serverName, status: "ready", account: null }],
    skills: [],
    apps: [],
    ...over,
  };
}

const GITHUB = plugin({
  id: "workspace:github",
  displayName: "GitHub",
  owner: { kind: "workspace" },
  skills: [{ name: "usage", kind: "overlay", serverName: "github" }],
});
const GMAIL = plugin({
  id: "person:gmail",
  displayName: "Gmail",
  owner: { kind: "person" },
  servers: [{ serverName: "gmail", status: "ready", account: { email: "pat@acme.test" } }],
});
const GRANOLA = plugin({
  id: "person:granola",
  displayName: "Granola",
  owner: { kind: "person" },
  granted: false,
  servers: [{ serverName: "granola", status: "ready", account: { name: "Pat" } }],
});

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

beforeEach(() => {
  plugins = [];
  personal = [];
  for (const m of [
    listPlugins,
    grantConnector,
    revokeConnector,
    disconnectPersonalConnector,
    listPersonalConnectors,
    initiateIdentityConnect,
    initiateComposioIdentityConnect,
  ]) {
    m.mockClear();
  }
  listPersonalConnectors.mockImplementation(async () => ({ connectors: personal }));
});

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(opts: { role?: "admin" | "member"; path?: string } = {}): Promise<Mounted> {
  const workspace = {
    id: WS_ID,
    name: "Helix",
    memberCount: 2,
    connectorCount: 0,
    userRole: opts.role ?? "admin",
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      <WorkspaceProvider initialWorkspaces={[workspace]} initialActiveId={WS_ID}>
        <NoticeProvider>
          <MemoryRouter initialEntries={[opts.path ?? `/w/${SLUG}/plugins`]}>
            <Routes>
              <Route path="/w/:slug/plugins" element={<PluginsPage />} />
              <Route path="/w/:slug/plugins/:pluginRef" element={<PluginPageStub />} />
            </Routes>
          </MemoryRouter>
        </NoticeProvider>
      </WorkspaceProvider>,
    );
  });
  await settle();
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

/** Where a row leads: the plugin page's route, showing the path it was opened at. */
function PluginPageStub() {
  const location = useLocation();
  return <p data-testid="plugin-page">{location.pathname}</p>;
}

function section(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="plugins-${id}"]`);
}

function rowNames(el: HTMLElement | null): string[] {
  return [...(el?.querySelectorAll('[data-testid="plugin-row"]') ?? [])].map(
    (r) => r.getAttribute("data-plugin-id") ?? "",
  );
}

function row(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-plugin-id="${id}"]`);
}

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

function action(r: HTMLElement): HTMLElement | null {
  return r.querySelector('[data-testid="plugin-action"]');
}

function account(container: HTMLElement, id: string): string | null | undefined {
  return row(container, id)?.querySelector('[data-testid="plugin-account"]')?.textContent;
}

/** Open the row's ⋯ menu and return its items' labels; the menu renders in a portal. */
async function openMenu(r: HTMLElement): Promise<HTMLElement> {
  await click(r.querySelector('[data-testid="plugin-menu"]'));
  const popup = document.body.querySelector<HTMLElement>('[data-testid="plugin-menu-popup"]');
  if (!popup) throw new Error("the row's menu did not open");
  return popup;
}

function menuItems(popup: HTMLElement): string[] {
  return [...popup.querySelectorAll('[role="menuitem"]')].map((i) => i.textContent?.trim() ?? "");
}

function menuItem(popup: HTMLElement, text: string): HTMLElement | undefined {
  return [...popup.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (i) => i.textContent?.trim() === text,
  );
}

function dialog(): HTMLElement {
  return document.body.querySelector<HTMLElement>('[role="dialog"]')!;
}

describe("PluginsPage — Installed", () => {
  test("reads the listing for the workspace the route names", async () => {
    mounted = await mount();
    expect(listPlugins).toHaveBeenCalledWith(WS_ID);
  });

  test("one group holds what acts here, workspace's and yours; the ungranted come last", async () => {
    plugins = [GRANOLA, GMAIL, GITHUB];
    mounted = await mount();
    expect(rowNames(section(mounted.container, "here"))).toEqual([
      "workspace:github",
      "person:gmail",
    ]);
    expect(rowNames(section(mounted.container, "yours-not-here"))).toEqual(["person:granola"]);
    // Whose a plugin is reads from its badge; no group says it.
    expect(section(mounted.container, "yours")).toBeNull();
  });

  test("within a group, what needs the viewer comes first, then by name", async () => {
    const LINEAR = plugin({
      id: "workspace:linear",
      displayName: "Linear",
      owner: { kind: "workspace" },
      servers: [{ serverName: "linear", status: "needs_auth", account: null }],
    });
    plugins = [GITHUB, GMAIL, LINEAR];
    mounted = await mount();
    expect(rowNames(section(mounted.container, "here"))).toEqual([
      "workspace:linear",
      "workspace:github",
      "person:gmail",
    ]);
  });

  test("a person's plugin carries the person badge and a workspace plugin does not", async () => {
    plugins = [GITHUB, GMAIL];
    mounted = await mount();
    const badge = '[data-testid="plugin-person-badge"]';
    expect(row(mounted.container, "person:gmail")?.querySelector(badge)).not.toBeNull();
    expect(row(mounted.container, "workspace:github")?.querySelector(badge)).toBeNull();
  });

  test("the subtitle names the account, not whose it is", async () => {
    plugins = [
      GITHUB,
      GMAIL,
      GRANOLA,
      plugin({
        id: "workspace:slack",
        displayName: "Slack",
        owner: { kind: "workspace" },
        servers: [{ serverName: "slack", status: "ready", account: { email: "ops@acme.test" } }],
      }),
    ];
    mounted = await mount();
    expect(account(mounted.container, "person:gmail")).toBe("pat@acme.test");
    expect(account(mounted.container, "person:granola")).toBe("Pat");
    expect(account(mounted.container, "workspace:github")).toBe("Workspace account · 1 skill");
    expect(account(mounted.container, "workspace:slack")).toBe("Workspace account · ops@acme.test");
    expect(mounted.container.textContent).not.toContain("Uses your account");
    expect(mounted.container.textContent).not.toContain("Uses the workspace's account");
  });

  test("a healthy row shows no button and no status", async () => {
    plugins = [GITHUB, GMAIL];
    mounted = await mount();
    for (const id of ["workspace:github", "person:gmail"]) {
      const r = row(mounted.container, id)!;
      expect(action(r)).toBeNull();
      expect(r.textContent).not.toContain("In use here");
      expect(button(r, "Stop using here")).toBeUndefined();
    }
  });

  test("the whole row opens the plugin's page, by its encoded id", async () => {
    plugins = [GITHUB, GMAIL];
    mounted = await mount();
    const links = (id: string) => [...row(mounted!.container, id)!.querySelectorAll("a")];
    expect(links("workspace:github").map((a) => a.getAttribute("href"))).toEqual([
      `/w/${SLUG}/plugins/workspace%3Agithub`,
    ]);
    // The link stretches over the row, and holds no control of its own.
    const link = links("person:gmail")[0]!;
    expect(link.getAttribute("href")).toBe(`/w/${SLUG}/plugins/person%3Agmail`);
    expect(link.className).toContain("after:absolute");
    expect(link.querySelector("button")).toBeNull();

    await click(link);
    expect(document.body.querySelector('[data-testid="plugin-page"]')?.textContent).toBe(
      `/w/${SLUG}/plugins/person%3Agmail`,
    );
  });

  test("a workspace plugin that needs a sign-in offers its admin Connect, which opens its page", async () => {
    plugins = [
      plugin({
        id: "workspace:linear",
        displayName: "Linear",
        owner: { kind: "workspace" },
        servers: [{ serverName: "linear", status: "needs_auth", account: null }],
      }),
    ];
    mounted = await mount();
    await click(button(row(mounted.container, "workspace:linear")!, "Connect"));
    expect(document.body.querySelector('[data-testid="plugin-page"]')?.textContent).toBe(
      `/w/${SLUG}/plugins/workspace%3Alinear`,
    );
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
  });

  test("a member sees a workspace plugin's status words instead of Connect", async () => {
    plugins = [
      plugin({
        id: "workspace:linear",
        displayName: "Linear",
        owner: { kind: "workspace" },
        servers: [{ serverName: "linear", status: "needs_auth", account: null }],
      }),
    ];
    mounted = await mount({ role: "member" });
    const r = row(mounted.container, "workspace:linear")!;
    expect(button(r, "Connect")).toBeUndefined();
    expect(action(r)?.textContent).toBe("Reconnect");
  });

  test("marks the plugin an OAuth sign-in just connected, and only that one", async () => {
    plugins = [GITHUB, GMAIL];
    mounted = await mount({ path: `/w/${SLUG}/plugins?connected=gmail&owner=person` });
    expect(row(mounted.container, "person:gmail")?.textContent).toContain("Connected just now");
    expect(row(mounted.container, "workspace:github")?.textContent).not.toContain(
      "Connected just now",
    );
  });

  test("a workspace and a person sharing a server name: marks only the owner that connected", async () => {
    const workspaceGmail = plugin({
      id: "workspace:gmail",
      displayName: "Gmail",
      owner: { kind: "workspace" },
    });
    plugins = [workspaceGmail, GMAIL];
    mounted = await mount({ path: `/w/${SLUG}/plugins?connected=gmail&owner=person` });
    expect(row(mounted.container, "person:gmail")?.textContent).toContain("Connected just now");
    expect(row(mounted.container, "workspace:gmail")?.textContent).not.toContain(
      "Connected just now",
    );
    mounted.unmount();

    mounted = await mount({ path: `/w/${SLUG}/plugins?connected=gmail&owner=workspace` });
    expect(row(mounted.container, "workspace:gmail")?.textContent).toContain("Connected just now");
    expect(row(mounted.container, "person:gmail")?.textContent).not.toContain("Connected just now");
  });

  test("marks nothing until the connected server is ready", async () => {
    plugins = [
      plugin({
        id: "workspace:linear",
        displayName: "Linear",
        owner: { kind: "workspace" },
        servers: [{ serverName: "linear", status: "connecting", account: null }],
      }),
    ];
    mounted = await mount({ path: `/w/${SLUG}/plugins?connected=linear&owner=workspace` });
    expect(row(mounted.container, "workspace:linear")?.textContent).not.toContain(
      "Connected just now",
    );
  });

  test("Use here grants only after the confirm, naming the account and workspace", async () => {
    plugins = [GRANOLA];
    mounted = await mount();
    await click(button(row(mounted.container, "person:granola")!, "Use here"));
    expect(grantConnector).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Use Granola (Pat) in Helix?");
    expect(document.body.textContent).toContain("Only you can use it here; other members can't.");

    plugins = [{ ...GRANOLA, granted: true }];
    await click(button(dialog(), "Use here"));
    expect(grantConnector).toHaveBeenCalledWith("granola", WS_ID);
    expect(rowNames(section(mounted.container, "here"))).toEqual(["person:granola"]);
    expect(section(mounted.container, "yours-not-here")).toBeNull();
  });

  test("Use here is offered only in the group not used here", async () => {
    plugins = [GITHUB, GMAIL, GRANOLA];
    mounted = await mount();
    expect(button(section(mounted.container, "here")!, "Use here")).toBeUndefined();
    expect(button(section(mounted.container, "yours-not-here")!, "Use here")).toBeDefined();
  });

  test("a person's granted, connected row's menu offers Open, Stop using here, and Disconnect", async () => {
    plugins = [GMAIL];
    mounted = await mount();
    const popup = await openMenu(row(mounted.container, "person:gmail")!);
    expect(menuItems(popup)).toEqual(["Open", "Stop using here", "Disconnect"]);
    expect(menuItem(popup, "Open")?.getAttribute("href")).toBe(`/w/${SLUG}/plugins/person%3Agmail`);
  });

  test("a workspace row's menu offers Open only", async () => {
    plugins = [GITHUB];
    mounted = await mount();
    const popup = await openMenu(row(mounted.container, "workspace:github")!);
    expect(menuItems(popup)).toEqual(["Open"]);
  });

  test("a row not used here offers no Stop using here", async () => {
    plugins = [GRANOLA];
    mounted = await mount();
    const popup = await openMenu(row(mounted.container, "person:granola")!);
    expect(menuItems(popup)).toEqual(["Open", "Disconnect"]);
  });

  test("Stop using here revokes the grant in this workspace, after the confirm", async () => {
    plugins = [GMAIL];
    mounted = await mount();
    const popup = await openMenu(row(mounted.container, "person:gmail")!);
    await click(menuItem(popup, "Stop using here"));
    expect(revokeConnector).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("Stop using Gmail here?");

    await click(button(dialog(), "Stop using here"));
    expect(revokeConnector).toHaveBeenCalledWith("gmail", WS_ID);
  });

  test("Disconnect signs out of the account, after the confirm naming where it turns off", async () => {
    plugins = [GMAIL];
    personal = [
      {
        serverName: "gmail",
        displayName: "Gmail",
        description: null,
        state: "authenticated",
        auth: "dcr",
        grantedWorkspaces: [WS_ID, "ws_other"],
      },
    ];
    mounted = await mount();
    const popup = await openMenu(row(mounted.container, "person:gmail")!);
    await click(menuItem(popup, "Disconnect"));
    expect(disconnectPersonalConnector).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("Disconnect Gmail?");
    expect(dialog().textContent).toContain("It turns off in the 2 workspaces it is on in.");

    await click(button(dialog(), "Disconnect"));
    expect(disconnectPersonalConnector).toHaveBeenCalledWith("gmail");
  });

  test("a member who cannot write the workspace still gets Use here", async () => {
    plugins = [GRANOLA];
    mounted = await mount({ role: "member" });
    expect(button(row(mounted.container, "person:granola")!, "Use here")).toBeDefined();
  });

  test("with nothing acting here, only a writer is offered Browse", async () => {
    mounted = await mount({ role: "admin" });
    expect(button(mounted.container, "Browse plugins")).toBeDefined();
    mounted.unmount();

    mounted = await mount({ role: "member" });
    expect(mounted.container.textContent).toContain("No plugins act in this workspace yet.");
    expect(button(mounted.container, "Browse plugins")).toBeUndefined();
  });
});

// A person's row offers its next step, and nothing once there is none: Use
// here signs in too when the plugin has no account behind it, Connect signs in
// one already on here, and one on here and signed in offers nothing.
describe("PluginsPage — a person's plugin's next step", () => {
  const notConnected = (p: Plugin): Plugin => ({
    ...p,
    servers: p.servers.map((s) => ({ ...s, status: "not_connected" as const, account: null })),
  });
  const BASSET = plugin({
    id: "person:bassethound",
    displayName: "Bassethound",
    owner: { kind: "person" },
    granted: false,
    servers: [{ serverName: "bassethound", status: "not_connected", account: null }],
  });
  function connector(over: Partial<PersonalConnector> = {}): PersonalConnector {
    return {
      serverName: "bassethound",
      displayName: "Bassethound",
      description: null,
      state: "not_authenticated",
      auth: "dcr",
      grantedWorkspaces: [],
      ...over,
    };
  }

  test("not on here, not connected: Use here, and the subtitle says it is not signed in", async () => {
    plugins = [BASSET];
    personal = [connector()];
    mounted = await mount();
    const r = row(mounted.container, "person:bassethound")!;
    expect(button(r, "Use here")?.disabled).toBe(false);
    expect(button(r, "Connect")).toBeUndefined();
    expect(account(mounted.container, "person:bassethound")).toBe("Not signed in");
  });

  test("not on here, connected: Use here", async () => {
    plugins = [GRANOLA];
    mounted = await mount();
    expect(button(row(mounted.container, "person:granola")!, "Use here")).toBeDefined();
  });

  test("on here, not connected: Connect, and nothing else beside it", async () => {
    plugins = [notConnected(GMAIL)];
    personal = [connector({ serverName: "gmail", displayName: "Gmail" })];
    mounted = await mount();
    const r = row(mounted.container, "person:gmail")!;
    expect(action(r)?.textContent).toBe("Connect");
    expect(button(r, "Stop using here")).toBeUndefined();
    expect(account(mounted.container, "person:gmail")).toBe("Not signed in");
  });

  test("on here, not connected: the menu has no Disconnect", async () => {
    plugins = [notConnected(GMAIL)];
    personal = [connector({ serverName: "gmail", displayName: "Gmail" })];
    mounted = await mount();
    const popup = await openMenu(row(mounted.container, "person:gmail")!);
    expect(menuItems(popup)).toEqual(["Open", "Stop using here"]);
  });

  test("on here, connected: offers nothing", async () => {
    plugins = [GMAIL];
    mounted = await mount();
    const r = row(mounted.container, "person:gmail")!;
    expect(action(r)).toBeNull();
    expect(r.querySelectorAll("button")).toHaveLength(1); // the ⋯ menu
  });

  test("Use here on a plugin with no sign-in waits for its record before it can start", async () => {
    plugins = [BASSET];
    listPersonalConnectors.mockImplementation(() => new Promise(() => {}));
    mounted = await mount();
    expect(button(row(mounted.container, "person:bassethound")!, "Use here")?.disabled).toBe(true);
  });

  test("Use here on a DCR plugin with no sign-in grants, then signs in back to Plugins", async () => {
    plugins = [BASSET];
    personal = [connector()];
    mounted = await mount();
    await click(button(row(mounted.container, "person:bassethound")!, "Use here"));
    expect(document.body.textContent).toContain("You'll sign in to Bassethound next.");

    await click(button(dialog(), "Use here"));
    expect(grantConnector).toHaveBeenCalledWith("bassethound", WS_ID);
    expect(initiateIdentityConnect).toHaveBeenCalledWith("bassethound", WS_ID);
    expect(initiateComposioIdentityConnect).not.toHaveBeenCalled();
    expect(grantConnector.mock.invocationCallOrder[0]).toBeLessThan(
      initiateIdentityConnect.mock.invocationCallOrder[0]!,
    );
  });

  test("Use here on a Composio plugin with no sign-in keys its sign-in on the catalog id", async () => {
    plugins = [BASSET];
    personal = [connector({ auth: "composio", connectorId: "ai.bassethound/bassethound" })];
    mounted = await mount();
    await click(button(row(mounted.container, "person:bassethound")!, "Use here"));
    await click(button(dialog(), "Use here"));
    expect(grantConnector).toHaveBeenCalledWith("bassethound", WS_ID);
    expect(initiateComposioIdentityConnect).toHaveBeenCalledWith(
      "ai.bassethound/bassethound",
      WS_ID,
    );
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
  });

  test("Use here on a connected plugin grants and starts no sign-in", async () => {
    plugins = [GRANOLA];
    mounted = await mount();
    await click(button(row(mounted.container, "person:granola")!, "Use here"));
    expect(document.body.textContent).not.toContain("sign in to Granola next");
    await click(button(dialog(), "Use here"));
    expect(grantConnector).toHaveBeenCalledWith("granola", WS_ID);
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
  });

  test("Connect signs in back to Plugins, and grants nothing", async () => {
    plugins = [notConnected(GMAIL)];
    personal = [connector({ serverName: "gmail", displayName: "Gmail" })];
    mounted = await mount();
    await click(button(row(mounted.container, "person:gmail")!, "Connect"));
    expect(initiateIdentityConnect).toHaveBeenCalledWith("gmail", WS_ID);
    expect(grantConnector).not.toHaveBeenCalled();
  });
});

describe("PluginsPage — Browse", () => {
  test("the directory offers Install to a writer", async () => {
    mounted = await mount({ role: "admin", path: `/w/${SLUG}/plugins?tab=browse` });
    expect(mounted.container.textContent).toContain("Acme Tasks");
    expect(button(mounted.container, "Install")).toBeDefined();
  });

  test("a member sees the directory without install actions", async () => {
    mounted = await mount({ role: "member", path: `/w/${SLUG}/plugins?tab=browse` });
    expect(mounted.container.textContent).toContain("Acme Tasks");
    expect(button(mounted.container, "Install")).toBeUndefined();
    expect(mounted.container.textContent).toContain("Workspace admin required");
  });

  test("the Browse tab opens the directory", async () => {
    mounted = await mount();
    await click(button(mounted.container, "Browse"));
    expect(mounted.container.textContent).toContain("Acme Tasks");
  });
});
