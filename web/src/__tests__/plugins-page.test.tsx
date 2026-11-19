// ---------------------------------------------------------------------------
// PluginsPage — what the agent can do in a workspace.
//
// Installed arranges the listing by who each item acts for (Shared, Just you,
// Yours not on here), gathers what needs the viewer at the top, and offers
// each row only what needs the viewer, with the rest in its ⋯ menu. A
// person's own plugin gets Use here (after a confirm) or, from its menu, Stop
// using here and Disconnect. Browse is the connector directory, whose install
// actions only a member who may write the workspace sees. Use here is the
// viewer's own grant, so any member gets it. The arrangement at scale (search,
// filters, show-all, collapse) is in plugins-installed-view.test.tsx.
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
const disconnectPersonalConnector = mock<typeof ApiClient.disconnectPersonalConnector>(
  async (serverName) => ({ ok: true, scope: "identity", serverName, revokedWorkspaces: 0 }),
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
  listPersonalConnectors,
  disconnectPersonalConnector,
  initiateIdentityConnect,
  initiateComposioIdentityConnect,
  listDirectory,
  getInstalledConnectors,
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");
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
  listPlugins.mockClear();
  grantConnector.mockClear();
  revokeConnector.mockClear();
  personal = [];
  for (const m of [
    disconnectPersonalConnector,
    listPersonalConnectors,
    initiateIdentityConnect,
    initiateComposioIdentityConnect,
  ]) {
    m.mockClear();
  }
  listPersonalConnectors.mockImplementation(async () => ({ connectors: personal }));
  localStorage.clear();
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

function section(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="installed-section-${id}"]`);
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

/** Open a collapsed section by its header. */
async function expand(container: HTMLElement, id: string): Promise<void> {
  const s = section(container, id);
  if (s?.getAttribute("data-collapsed") === "true") await click(s.querySelector("h2 button"));
}

/** Open the row's ⋯ menu; the menu renders in a portal. */
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

  test("sections plugins by who they act for, with the ungranted ones last", async () => {
    plugins = [GRANOLA, GMAIL, GITHUB];
    mounted = await mount();
    expect(rowNames(section(mounted.container, "shared"))).toEqual(["workspace:github"]);
    expect(rowNames(section(mounted.container, "you"))).toEqual(["person:gmail"]);
    await expand(mounted.container, "not-here");
    expect(rowNames(section(mounted.container, "not-here"))).toEqual(["person:granola"]);
    const order = [
      ...mounted.container.querySelectorAll('section[data-testid^="installed-section-"]'),
    ].map((s) => s.getAttribute("data-testid"));
    expect(order).toEqual([
      "installed-section-shared",
      "installed-section-you",
      "installed-section-not-here",
    ]);
  });

  test("a row inside its section carries no owner mark", async () => {
    plugins = [GITHUB, GMAIL];
    mounted = await mount();
    expect(mounted.container.querySelector('[data-testid="owner-mark"]')).toBeNull();
  });

  test("the account line names the account when the sign-in recorded one", async () => {
    plugins = [GITHUB, GMAIL, GRANOLA];
    mounted = await mount();
    await expand(mounted.container, "not-here");
    const account = (id: string) =>
      row(mounted!.container, id)?.querySelector('[data-testid="plugin-account"]')?.textContent;
    expect(account("person:gmail")).toBe("pat@acme.test");
    expect(account("person:granola")).toBe("Pat");
    // No account recorded: the line says whose, and invents no account.
    expect(account("workspace:github")).toBe("Workspace account");
  });

  test("a workspace sign-in a member cannot do shows the connector list's status words", async () => {
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
    expect(r.querySelector('[data-testid="plugin-status"]')?.textContent).toBe("Reconnect");
    expect(button(r, "Reconnect")).toBeUndefined();
  });

  test("a healthy row offers nothing but its menu", async () => {
    plugins = [GITHUB];
    mounted = await mount();
    const r = row(mounted.container, "workspace:github")!;
    expect(r.querySelector('[data-testid="plugin-action"]')).toBeNull();
    expect(r.querySelectorAll("button")).toHaveLength(1);
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

  test("rows link to each plugin's page, by its encoded id", async () => {
    plugins = [GITHUB, GMAIL];
    mounted = await mount();
    const href = (id: string) =>
      row(mounted!.container, id)?.querySelector("a")?.getAttribute("href");
    expect(href("workspace:github")).toBe(`/w/${SLUG}/plugins/workspace%3Agithub`);
    expect(href("person:gmail")).toBe(`/w/${SLUG}/plugins/person%3Agmail`);
  });

  test("Use here grants only after the confirm, naming the account and workspace", async () => {
    plugins = [GRANOLA];
    mounted = await mount();
    await expand(mounted.container, "not-here");
    await click(button(row(mounted.container, "person:granola")!, "Use here"));
    expect(grantConnector).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Use Granola (Pat) in Helix?");
    expect(document.body.textContent).toContain("Only you can use it here; other members can't.");

    plugins = [{ ...GRANOLA, granted: true }];
    await click(button(dialog(), "Use here"));
    expect(grantConnector).toHaveBeenCalledWith("granola", WS_ID);
    expect(rowNames(section(mounted.container, "you"))).toEqual(["person:granola"]);
    expect(section(mounted.container, "not-here")).toBeNull();
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

  test("Stop using here revokes the grant in this workspace after its confirm", async () => {
    plugins = [GMAIL];
    mounted = await mount();
    const popup = await openMenu(row(mounted.container, "person:gmail")!);
    await click(menuItem(popup, "Stop using here"));
    expect(revokeConnector).not.toHaveBeenCalled();
    await click(button(dialog(), "Stop using here"));
    expect(revokeConnector).toHaveBeenCalledWith("gmail", WS_ID);
  });

  test("Disconnect signs out after its confirm", async () => {
    plugins = [GMAIL];
    mounted = await mount();
    const popup = await openMenu(row(mounted.container, "person:gmail")!);
    await click(menuItem(popup, "Disconnect"));
    expect(disconnectPersonalConnector).not.toHaveBeenCalled();
    await click(button(dialog(), "Disconnect"));
    expect(disconnectPersonalConnector).toHaveBeenCalledWith("gmail");
  });

  test("a member who cannot write the workspace still gets Use here", async () => {
    plugins = [GRANOLA];
    mounted = await mount({ role: "member" });
    await expand(mounted.container, "not-here");
    expect(button(row(mounted.container, "person:granola")!, "Use here")).toBeDefined();
  });

  test("with nothing installed, only a writer is offered Browse; anyone may write a skill", async () => {
    mounted = await mount({ role: "admin" });
    expect(mounted.container.textContent).toContain("Nothing is installed here yet.");
    expect(button(mounted.container, "Browse plugins")).toBeDefined();
    expect(button(mounted.container, "Write a skill")).toBeDefined();
    mounted.unmount();

    mounted = await mount({ role: "member" });
    expect(mounted.container.textContent).toContain("Nothing is installed here yet.");
    expect(button(mounted.container, "Browse plugins")).toBeUndefined();
    expect(button(mounted.container, "Write a skill")).toBeDefined();
  });

  test("Browse directory in the header opens Browse", async () => {
    plugins = [GITHUB];
    mounted = await mount();
    await click(button(mounted.container, "Browse directory"));
    expect(mounted.container.textContent).toContain("Acme Tasks");
  });

  test("Add offers a plugin from the directory and writing a skill", async () => {
    plugins = [GITHUB];
    mounted = await mount();
    await click(mounted.container.querySelector('[data-testid="plugins-add"]'));
    const popup = document.body.querySelector<HTMLElement>('[data-testid="plugins-add-popup"]')!;
    expect(menuItems(popup)).toEqual(["Plugin from the directory", "Write a skill"]);
    await click(menuItem(popup, "Plugin from the directory"));
    expect(mounted.container.textContent).toContain("Acme Tasks");
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
  /** The row in its section, not its copy under Needs you. */
  const inSection = (id: string, pluginId: string) =>
    section(mounted!.container, id)!.querySelector<HTMLElement>(`[data-plugin-id="${pluginId}"]`)!;
  const action = (r: HTMLElement) => r.querySelector('[data-testid="plugin-action"]');
  const account = (r: HTMLElement) =>
    r.querySelector('[data-testid="plugin-account"]')?.textContent;

  test("not on here, not connected: Use here, and the subtitle says it is not signed in", async () => {
    plugins = [BASSET];
    personal = [connector()];
    mounted = await mount();
    await expand(mounted.container, "not-here");
    const r = inSection("not-here", "person:bassethound");
    expect(button(r, "Use here")?.disabled).toBe(false);
    expect(button(r, "Connect")).toBeUndefined();
    expect(account(r)).toBe("Not signed in");
  });

  test("on here, not connected: Connect, and nothing else beside it", async () => {
    plugins = [notConnected(GMAIL)];
    personal = [connector({ serverName: "gmail", displayName: "Gmail" })];
    mounted = await mount();
    const r = inSection("you", "person:gmail");
    expect(action(r)?.textContent).toBe("Connect");
    expect(account(r)).toBe("Not signed in");
  });

  test("on here, not connected: the menu has no Disconnect", async () => {
    plugins = [notConnected(GMAIL)];
    personal = [connector({ serverName: "gmail", displayName: "Gmail" })];
    mounted = await mount();
    const popup = await openMenu(inSection("you", "person:gmail"));
    expect(menuItems(popup)).toEqual(["Open", "Stop using here"]);
  });

  test("Use here on a plugin with no sign-in waits for its record before it can start", async () => {
    plugins = [BASSET];
    listPersonalConnectors.mockImplementation(() => new Promise(() => {}));
    mounted = await mount();
    await expand(mounted.container, "not-here");
    expect(button(inSection("not-here", "person:bassethound"), "Use here")?.disabled).toBe(true);
  });

  test("Use here on a DCR plugin with no sign-in grants, then signs in back to Plugins", async () => {
    plugins = [BASSET];
    personal = [connector()];
    mounted = await mount();
    await expand(mounted.container, "not-here");
    await click(button(inSection("not-here", "person:bassethound"), "Use here"));
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
    await expand(mounted.container, "not-here");
    await click(button(inSection("not-here", "person:bassethound"), "Use here"));
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
    await expand(mounted.container, "not-here");
    await click(button(inSection("not-here", "person:granola"), "Use here"));
    expect(document.body.textContent).not.toContain("sign in to Granola next");
    await click(button(dialog(), "Use here"));
    expect(grantConnector).toHaveBeenCalledWith("granola", WS_ID);
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
  });

  test("Connect signs in back to Plugins, and grants nothing", async () => {
    plugins = [notConnected(GMAIL)];
    personal = [connector({ serverName: "gmail", displayName: "Gmail" })];
    mounted = await mount();
    await click(button(inSection("you", "person:gmail"), "Connect"));
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
