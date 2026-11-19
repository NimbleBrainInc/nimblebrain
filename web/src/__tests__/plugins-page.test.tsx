// ---------------------------------------------------------------------------
// PluginsPage — what the agent can do in a workspace.
//
// Installed groups the listing by whose each plugin is and whether it acts
// here, says whose account each uses, and offers the viewer's own plugins a
// Use here (after a confirm) or Stop using here. Browse is the connector
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
  listPersonalConnectors,
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
        <MemoryRouter initialEntries={[opts.path ?? `/w/${SLUG}/plugins`]}>
          <Routes>
            <Route path="/w/:slug/plugins" element={<PluginsPage />} />
          </Routes>
        </MemoryRouter>
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

describe("PluginsPage — Installed", () => {
  test("reads the listing for the workspace the route names", async () => {
    mounted = await mount();
    expect(listPlugins).toHaveBeenCalledWith(WS_ID);
  });

  test("groups plugins by owner, with the ungranted ones last", async () => {
    plugins = [GRANOLA, GMAIL, GITHUB];
    mounted = await mount();
    expect(rowNames(section(mounted.container, "workspace"))).toEqual(["workspace:github"]);
    expect(rowNames(section(mounted.container, "yours"))).toEqual(["person:gmail"]);
    expect(rowNames(section(mounted.container, "yours-not-here"))).toEqual(["person:granola"]);
  });

  test("a person's plugin carries the person badge and a workspace plugin does not", async () => {
    plugins = [GITHUB, GMAIL];
    mounted = await mount();
    const badge = '[data-testid="plugin-person-badge"]';
    expect(row(mounted.container, "person:gmail")?.querySelector(badge)).not.toBeNull();
    expect(row(mounted.container, "workspace:github")?.querySelector(badge)).toBeNull();
  });

  test("the account line names the account when the sign-in recorded one", async () => {
    plugins = [GITHUB, GMAIL, GRANOLA];
    mounted = await mount();
    const account = (id: string) =>
      row(mounted!.container, id)?.querySelector('[data-testid="plugin-account"]')?.textContent;
    expect(account("person:gmail")).toBe("Uses your account · pat@acme.test");
    expect(account("person:granola")).toBe("Uses your account · Pat");
    // No account recorded: the line says whose, and invents no account.
    expect(account("workspace:github")).toBe("Uses the workspace's account · 1 skill");
  });

  test("a server that is not ready shows the connector list's status words", async () => {
    plugins = [
      plugin({
        id: "workspace:linear",
        displayName: "Linear",
        owner: { kind: "workspace" },
        servers: [{ serverName: "linear", status: "needs_auth", account: null }],
      }),
    ];
    mounted = await mount();
    expect(row(mounted.container, "workspace:linear")?.textContent).toContain("Reconnect");
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
    await click(button(row(mounted.container, "person:granola")!, "Use here"));
    expect(grantConnector).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Use Granola (Pat) in Helix?");
    expect(document.body.textContent).toContain("Only you can use it here; other members can't.");

    plugins = [{ ...GRANOLA, granted: true }];
    const dialog = document.body.querySelector('[role="dialog"]')!;
    await click(button(dialog, "Use here"));
    expect(grantConnector).toHaveBeenCalledWith("granola", WS_ID);
    expect(rowNames(section(mounted.container, "yours"))).toEqual(["person:granola"]);
    expect(section(mounted.container, "yours-not-here")).toBeNull();
  });

  test("Stop using here revokes the grant in this workspace", async () => {
    plugins = [GMAIL];
    mounted = await mount();
    await click(button(row(mounted.container, "person:gmail")!, "Stop using here"));
    expect(revokeConnector).toHaveBeenCalledWith("gmail", WS_ID);
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

// The button is always the next step: Use here signs in too when the plugin has
// no account behind it, Connect signs in one already on here, and one on here
// and signed in reads In use here.
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
  const PLUGINS_PATH = `/w/${SLUG}/plugins`;

  test("not on here, not connected: Use here", async () => {
    plugins = [BASSET];
    personal = [connector()];
    mounted = await mount();
    const r = row(mounted.container, "person:bassethound")!;
    expect(button(r, "Use here")?.disabled).toBe(false);
    expect(button(r, "Connect")).toBeUndefined();
  });

  test("not on here, connected: Use here", async () => {
    plugins = [GRANOLA];
    mounted = await mount();
    expect(button(row(mounted.container, "person:granola")!, "Use here")).toBeDefined();
  });

  test("on here, not connected: Connect, with Stop using here beside it", async () => {
    plugins = [notConnected(GMAIL)];
    personal = [connector({ serverName: "gmail", displayName: "Gmail" })];
    mounted = await mount();
    const r = row(mounted.container, "person:gmail")!;
    expect(button(r, "Connect")).toBeDefined();
    expect(button(r, "Stop using here")).toBeDefined();
    expect(r.querySelector('[data-testid="plugin-in-use"]')).toBeNull();
  });

  test("on here, connected: reads In use here, with Stop using here beside it", async () => {
    plugins = [GMAIL];
    mounted = await mount();
    const r = row(mounted.container, "person:gmail")!;
    expect(r.querySelector('[data-testid="plugin-in-use"]')?.textContent).toBe("In use here");
    expect(button(r, "Connect")).toBeUndefined();
    expect(button(r, "Stop using here")).toBeDefined();
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

    await click(button(document.body.querySelector('[role="dialog"]')!, "Use here"));
    expect(grantConnector).toHaveBeenCalledWith("bassethound", WS_ID);
    expect(initiateIdentityConnect).toHaveBeenCalledWith("bassethound", PLUGINS_PATH);
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
    await click(button(document.body.querySelector('[role="dialog"]')!, "Use here"));
    expect(grantConnector).toHaveBeenCalledWith("bassethound", WS_ID);
    expect(initiateComposioIdentityConnect).toHaveBeenCalledWith(
      "ai.bassethound/bassethound",
      PLUGINS_PATH,
    );
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
  });

  test("Use here on a connected plugin grants and starts no sign-in", async () => {
    plugins = [GRANOLA];
    mounted = await mount();
    await click(button(row(mounted.container, "person:granola")!, "Use here"));
    expect(document.body.textContent).not.toContain("sign in to Granola next");
    await click(button(document.body.querySelector('[role="dialog"]')!, "Use here"));
    expect(grantConnector).toHaveBeenCalledWith("granola", WS_ID);
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
  });

  test("Connect signs in back to Plugins, and grants nothing", async () => {
    plugins = [notConnected(GMAIL)];
    personal = [connector({ serverName: "gmail", displayName: "Gmail" })];
    mounted = await mount();
    await click(button(row(mounted.container, "person:gmail")!, "Connect"));
    expect(initiateIdentityConnect).toHaveBeenCalledWith("gmail", PLUGINS_PATH);
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
