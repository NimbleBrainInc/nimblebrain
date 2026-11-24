// ---------------------------------------------------------------------------
// PluginsPage and PluginsBrowsePage.
//
// Plugins lists what is installed, split Workspace | Personal with a search.
// Each row is a link to the plugin's page, where every action is: it names the
// plugin and what it does, and says its state in words, never a button. A
// person's own plugin not on here says Off here; its page turns it on. A line
// above the list appears only while something in the segment needs the viewer,
// and carries the action when one plugin does. Browse plugins is its own page:
// the directory, whose install actions only a member who may write the
// workspace sees.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";
import type { Plugin } from "../_generated/platform-schemas/plugins";
import type * as ApiClient from "../api/client";
import type { PersonalConnector } from "../api/client";
import { __internal__ as eventsClient } from "../api/events-client";
import type { ConnectEventsOptions, EventConnection } from "../api/sse";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const WS_ID = "ws_003eba8844413cd9";

let plugins: Plugin[] = [];

const listPlugins = mock<typeof ApiClient.listPlugins>(async (wsId) => ({ wsId, plugins }));
const grantConnector = mock<typeof ApiClient.grantConnector>(async () => {});
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
// The directory's audience dialog reads nothing else; this suite is about plugins.
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
const { PluginsBrowsePage } = await import("../pages/PluginsBrowsePage");
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
  description: "Repositories, issues, and pull requests",
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
const notConnected = (p: Plugin): Plugin => ({
  ...p,
  servers: p.servers.map((s) => ({ ...s, status: "not_connected" as const, account: null })),
});

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
  location = "";
  listPlugins.mockClear();
  grantConnector.mockClear();
  personal = [];
  for (const m of [
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

function Probe() {
  const here = useLocation();
  location = `${here.pathname}${here.search}`;
  return null;
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
            <Probe />
            <Routes>
              <Route path="/w/:slug/plugins" element={<PluginsPage />} />
              <Route path="/w/:slug/plugins/browse/*" element={<PluginsBrowsePage />} />
              <Route path="/w/:slug/plugins/:pluginRef" element={<p>plugin page</p>} />
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

function rowIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid="plugin-row"]')].map(
    (r) => r.getAttribute("data-plugin-id") ?? "",
  );
}

function row(container: HTMLElement, id: string): HTMLElement | null {
  return container.querySelector(`[data-plugin-id="${id}"]`);
}

function button(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

function segmentButton(container: HTMLElement, id: "workspace" | "personal"): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-segment="${id}"]`)!;
}

function segmentCount(container: HTMLElement, id: "workspace" | "personal"): string {
  return (
    segmentButton(container, id).querySelector('[data-testid="segment-count"]')?.textContent ?? ""
  );
}

function needsYou(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-testid="needs-you"]');
}

async function click(el: Element | null | undefined): Promise<void> {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

async function type(container: HTMLElement, text: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('[data-testid="list-search"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await settle();
}

async function personalSegment(container: HTMLElement): Promise<void> {
  await click(segmentButton(container, "personal"));
}

describe("PluginsPage — the page", () => {
  test("reads the listing for the workspace the route names", async () => {
    mounted = await mount();
    expect(listPlugins).toHaveBeenCalledWith(WS_ID);
  });

  test("is titled Plugins, with Browse plugins as its one action", async () => {
    plugins = [GITHUB];
    mounted = await mount();
    expect(mounted.container.querySelector("h1")?.textContent).toBe("Plugins");
    const header = mounted.container.querySelector('[data-testid="list-page-header"]')!;
    expect([...header.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"))).toEqual(
      ["Browse plugins"],
    );
    await click(header.querySelector("button"));
    expect(location).toBe(`/w/${SLUG}/plugins/browse`);
  });

  test("has no tabs, kind filter, owner filter, or Add menu", async () => {
    plugins = [GITHUB, GMAIL];
    mounted = await mount();
    expect(mounted.container.querySelector('[role="tablist"]')).toBeNull();
    expect(mounted.container.querySelector("select")).toBeNull();
    expect(button(mounted.container, "Add")).toBeUndefined();
    expect(button(mounted.container, "Browse directory")).toBeUndefined();
    expect(mounted.container.querySelector('[data-testid="owner-mark"]')).toBeNull();
  });

  test("an old Browse tab address lands on Browse plugins, keeping its query", async () => {
    mounted = await mount({ path: `/w/${SLUG}/plugins?tab=browse&connected=x` });
    expect(location).toBe(`/w/${SLUG}/plugins/browse?connected=x`);
    expect(mounted.container.querySelector("h1")?.textContent).toBe("Browse plugins");
  });

  test("with nothing installed, says so", async () => {
    mounted = await mount();
    expect(mounted.container.textContent).toContain("No plugins here yet.");
  });
});

describe("PluginsPage — Workspace | Personal", () => {
  test("counts each segment and lists the workspace's by default", async () => {
    plugins = [GRANOLA, GMAIL, GITHUB];
    mounted = await mount();
    expect(segmentCount(mounted.container, "workspace")).toBe("1");
    expect(segmentCount(mounted.container, "personal")).toBe("2");
    expect(segmentButton(mounted.container, "workspace").getAttribute("aria-pressed")).toBe("true");
    expect(rowIds(mounted.container)).toEqual(["workspace:github"]);
  });

  test("Personal lists the viewer's own, on here first, then not on here", async () => {
    plugins = [GRANOLA, GMAIL, GITHUB];
    mounted = await mount();
    await personalSegment(mounted.container);
    expect(rowIds(mounted.container)).toEqual(["person:gmail", "person:granola"]);
    const state = (id: string) =>
      row(mounted!.container, id)?.querySelector('[data-testid="plugin-state"]')?.textContent;
    expect(state("person:granola")).toBe("Off here");
    expect(state("person:gmail")).toBe("pat@acme.test · on here");
  });

  test("opens on Personal when the workspace has none and the viewer has some", async () => {
    plugins = [GMAIL];
    mounted = await mount();
    expect(segmentButton(mounted.container, "personal").getAttribute("aria-pressed")).toBe("true");
    expect(rowIds(mounted.container)).toEqual(["person:gmail"]);
  });

  test("an empty segment says so", async () => {
    plugins = [GITHUB];
    mounted = await mount();
    await personalSegment(mounted.container);
    expect(mounted.container.querySelector('[data-testid="list-empty"]')?.textContent).toContain(
      "You have no plugins of your own yet.",
    );
  });

  test("search narrows the segment by name or account, and says when nothing matches", async () => {
    plugins = [GMAIL, GRANOLA, GITHUB];
    mounted = await mount();
    await personalSegment(mounted.container);
    await type(mounted.container, "acme.test");
    expect(rowIds(mounted.container)).toEqual(["person:gmail"]);
    await type(mounted.container, "zzz");
    expect(mounted.container.querySelector('[data-testid="list-empty"]')?.textContent).toBe(
      'No plugins match "zzz".',
    );
    // Counts are the segments', not the search's.
    expect(segmentCount(mounted.container, "personal")).toBe("2");
  });
});

describe("PluginsPage — rows", () => {
  test("a ready row says its state on the right: the account it uses, else Connected", async () => {
    plugins = [
      GITHUB,
      plugin({
        id: "workspace:linear",
        displayName: "Linear",
        owner: { kind: "workspace" },
        servers: [{ serverName: "linear", status: "ready", account: { email: "ops@acme.test" } }],
      }),
      GMAIL,
      GRANOLA,
    ];
    mounted = await mount();
    const state = (id: string) =>
      row(mounted!.container, id)?.querySelector('[data-testid="plugin-state"]')?.textContent;
    const account = (id: string) =>
      row(mounted!.container, id)?.querySelector('[data-testid="plugin-account"]')?.textContent;
    expect(state("workspace:github")).toBe("Connected");
    expect(state("workspace:linear")).toBe("ops@acme.test");
    expect(account("workspace:linear")).toBe("ops@acme.test");
    await personalSegment(mounted.container);
    // A person's plugin says whether it is on here.
    expect(state("person:gmail")).toBe("pat@acme.test · on here");
    expect(account("person:gmail")).toBe("pat@acme.test");
    expect(state("person:granola")).toBe("Off here");
  });

  test("a row's second line says what the plugin does, and describes its link", async () => {
    plugins = [
      GITHUB,
      plugin({ id: "workspace:crm", displayName: "CRM", owner: { kind: "workspace" } }),
    ];
    mounted = await mount();
    const r = row(mounted.container, "workspace:github")!;
    const description = r.querySelector('[data-testid="plugin-description"]')!;
    expect(description.textContent).toBe("Repositories, issues, and pull requests");
    expect(description.className).toContain("truncate");
    expect(r.querySelector("a")?.getAttribute("aria-describedby")).toBe(description.id);
    // With no description, the row is the name alone.
    const crm = row(mounted.container, "workspace:crm")!;
    expect(crm.querySelector('[data-testid="plugin-description"]')).toBeNull();
    expect(crm.querySelector("a")?.hasAttribute("aria-describedby")).toBe(false);
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
    expect(needsYou(mounted.container)).toBeNull();
  });

  test("a row whose only step is its page says what is wrong, with no Open button", async () => {
    plugins = [
      plugin({
        id: "workspace:crm",
        displayName: "CRM",
        owner: { kind: "workspace" },
        servers: [{ serverName: "crm", status: "failed", account: null }],
      }),
      plugin({
        id: "workspace:billing",
        displayName: "Billing",
        owner: { kind: "workspace" },
        servers: [{ serverName: "billing", status: "needs_setup", account: null }],
      }),
    ];
    mounted = await mount();
    for (const [id, words] of [
      ["workspace:crm", "Failed to start"],
      ["workspace:billing", "Needs setup"],
    ] as const) {
      const r = row(mounted.container, id)!;
      expect(r.querySelector('[data-testid="plugin-attention"]')?.textContent).toBe(words);
      expect(r.querySelectorAll("button")).toHaveLength(0);
      expect(r.querySelector("a")?.getAttribute("href")).toContain(
        `/plugins/${encodeURIComponent(id)}`,
      );
    }
  });

  test("a healthy row has no control and no menu: only its link and a decorative ›", async () => {
    plugins = [GITHUB];
    mounted = await mount();
    const r = row(mounted.container, "workspace:github")!;
    expect(r.querySelector('[data-testid="plugin-action"]')).toBeNull();
    expect(r.querySelectorAll("button")).toHaveLength(0);
    expect(r.querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(r.querySelectorAll("a")).toHaveLength(1);
    const chevron = r.querySelector("svg:last-child")!;
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
  });

  test("rows link to each plugin's page, by its encoded id, named by the plugin", async () => {
    plugins = [GITHUB, GMAIL];
    mounted = await mount();
    const link = (id: string) => row(mounted!.container, id)?.querySelector("a");
    expect(link("workspace:github")?.getAttribute("href")).toBe(
      `/w/${SLUG}/plugins/workspace%3Agithub`,
    );
    expect(link("workspace:github")?.textContent).toBe("GitHub");
    await click(link("workspace:github"));
    expect(location).toBe(`/w/${SLUG}/plugins/workspace%3Agithub`);
  });

  test("a person's plugin row links to its page too", async () => {
    plugins = [GITHUB, GMAIL];
    mounted = await mount();
    await personalSegment(mounted.container);
    expect(row(mounted.container, "person:gmail")?.querySelector("a")?.getAttribute("href")).toBe(
      `/w/${SLUG}/plugins/person%3Agmail`,
    );
  });

  test("no row holds a control: Use here and Connect are on the plugin's page", async () => {
    plugins = [GRANOLA, notConnected(GMAIL), { ...notConnected(GRANOLA), id: "person:other" }];
    mounted = await mount();
    await personalSegment(mounted.container);
    for (const r of mounted.container.querySelectorAll('[data-testid="plugin-row"]')) {
      expect(r.querySelectorAll("button")).toHaveLength(0);
      expect(r.querySelector("a")).not.toBeNull();
    }
  });

  test("marks the plugin an OAuth sign-in just connected, opening on its segment", async () => {
    plugins = [GITHUB, GMAIL];
    mounted = await mount({ path: `/w/${SLUG}/plugins?connected=gmail&owner=person` });
    expect(segmentButton(mounted.container, "personal").getAttribute("aria-pressed")).toBe("true");
    expect(row(mounted.container, "person:gmail")?.textContent).toContain("Connected just now");
  });

  test("a workspace and a person sharing a server name: marks only the owner that connected", async () => {
    const workspaceGmail = plugin({
      id: "workspace:gmail",
      displayName: "Gmail",
      owner: { kind: "workspace" },
    });
    plugins = [workspaceGmail, GMAIL];
    mounted = await mount({ path: `/w/${SLUG}/plugins?connected=gmail&owner=workspace` });
    expect(row(mounted.container, "workspace:gmail")?.textContent).toContain("Connected just now");
    await personalSegment(mounted.container);
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

  test("a row is two lines at every width and one tap target at least 44px tall", async () => {
    plugins = [GITHUB];
    mounted = await mount();
    const text = row(mounted.container, "workspace:github")!.querySelector(
      '[data-testid="row-text"]',
    )!;
    expect(text.className).toContain("flex-col");
    expect(text.className).not.toContain("flex-row");
    const r = row(mounted.container, "workspace:github")!;
    expect(r.className).toContain("min-h-11");
  });

  test("on a narrow column the header action is an icon, the bar stacks, and the search is full width", async () => {
    plugins = [GITHUB];
    mounted = await mount();
    const action = mounted.container.querySelector('[data-testid="plugins-browse"]')!;
    expect(action.getAttribute("aria-label")).toBe("Browse plugins");
    expect(action.querySelector("span")?.className).toContain("@max-[40rem]/main:sr-only");
    const bar = mounted.container.querySelector('[data-testid="segment-bar"]')!;
    expect(bar.className).toContain("flex-col");
    expect(bar.className).toContain("@min-[40rem]/main:flex-row");
    // The segments share the narrow width at 44px, and size to their labels
    // once the column is wide.
    for (const b of mounted.container.querySelectorAll('[data-testid="segment"] button')) {
      expect(b.className).toContain("flex-1");
      expect(b.className).toContain("h-11");
      expect(b.className).toContain("@min-[40rem]/main:flex-none");
    }
  });
});

describe("PluginsPage — Needs you", () => {
  const notion = plugin({
    id: "workspace:notion",
    displayName: "Notion",
    owner: { kind: "workspace" },
    servers: [{ serverName: "notion", status: "not_connected", account: null }],
  });
  const linear = plugin({
    id: "workspace:linear",
    displayName: "Linear",
    owner: { kind: "workspace" },
    servers: [{ serverName: "linear", status: "needs_auth", account: null }],
  });

  test("is absent when nothing in the segment needs the viewer", async () => {
    plugins = [GITHUB, notConnected(GMAIL)];
    mounted = await mount();
    expect(needsYou(mounted.container)).toBeNull();
  });

  test("with one, names it and carries its action, and its row says what is wrong instead", async () => {
    plugins = [GITHUB, notion];
    mounted = await mount();
    const line = needsYou(mounted.container)!;
    expect(line.textContent).toContain("1 needs you");
    expect(line.querySelector('[data-testid="needs-you-reason"]')?.textContent).toBe(
      "Notion isn't signed in.",
    );
    expect(button(line, "Connect")).toBeDefined();
    const r = row(mounted.container, "workspace:notion")!;
    expect(button(r, "Connect")).toBeUndefined();
    expect(r.querySelector('[data-testid="plugin-attention"]')?.textContent).toBe("Not signed in");
    // What needs the viewer is listed first.
    expect(rowIds(mounted.container)).toEqual(["workspace:notion", "workspace:github"]);
  });

  test("its action is the row's: a workspace plugin opens its page to connect there", async () => {
    plugins = [notion];
    mounted = await mount();
    await click(button(needsYou(mounted.container)!, "Connect"));
    expect(location).toBe(`/w/${SLUG}/plugins/workspace%3Anotion`);
  });

  test("with more than one, counts them and filters the list to them", async () => {
    plugins = [GITHUB, notion, linear];
    mounted = await mount();
    const line = needsYou(mounted.container)!;
    expect(line.textContent).toContain("2 need you");
    // Each row says what is wrong; the actions are on the plugins' pages.
    const words = (id: string) =>
      row(mounted!.container, id)?.querySelector('[data-testid="plugin-attention"]')?.textContent;
    expect(words("workspace:notion")).toBe("Not signed in");
    expect(words("workspace:linear")).toBe("Sign-in expired");
    expect(row(mounted.container, "workspace:notion")!.querySelectorAll("button")).toHaveLength(0);
    await click(button(line, "Show them"));
    expect(rowIds(mounted.container)).toEqual(["workspace:linear", "workspace:notion"]);
    await click(button(needsYou(mounted.container)!, "Show all"));
    expect(rowIds(mounted.container)).toHaveLength(3);
  });

  test("counts only the selected segment", async () => {
    plugins = [notion, notConnected(GMAIL)];
    personal = [];
    mounted = await mount();
    expect(needsYou(mounted.container)?.textContent).toContain("Notion isn't signed in.");
    await personalSegment(mounted.container);
    expect(needsYou(mounted.container)?.textContent).toContain("Gmail isn't signed in.");
  });

  test("a workspace sign-in is not a member's to do, so it does not need them", async () => {
    plugins = [notion];
    mounted = await mount({ role: "member" });
    expect(needsYou(mounted.container)).toBeNull();
  });
});

describe("PluginsPage — a person's plugin", () => {
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

  test("not on here: the row says Off here and needs nothing of the viewer", async () => {
    plugins = [BASSET];
    personal = [connector()];
    mounted = await mount();
    const r = row(mounted.container, "person:bassethound")!;
    expect(r.querySelector('[data-testid="plugin-state"]')?.textContent).toBe("Off here");
    expect(r.querySelectorAll("button")).toHaveLength(0);
    // Turning it on here is a choice, made on its page, not something that needs the viewer.
    expect(needsYou(mounted.container)).toBeNull();
  });

  test("on here, not connected: Connect on the Needs-you line, and the row says it once", async () => {
    plugins = [notConnected(GMAIL)];
    personal = [connector({ serverName: "gmail", displayName: "Gmail" })];
    mounted = await mount();
    expect(button(needsYou(mounted.container)!, "Connect")).toBeDefined();
    const r = row(mounted.container, "person:gmail")!;
    expect(r.querySelector('[data-testid="plugin-action"]')).toBeNull();
    expect(r.querySelector('[data-testid="plugin-attention"]')?.textContent).toBe("Not signed in");
  });

  test("Connect signs in back to Plugins, and grants nothing", async () => {
    plugins = [notConnected(GMAIL)];
    personal = [connector({ serverName: "gmail", displayName: "Gmail" })];
    mounted = await mount();
    await click(button(needsYou(mounted.container)!, "Connect"));
    expect(initiateIdentityConnect).toHaveBeenCalledWith("gmail", WS_ID);
    expect(grantConnector).not.toHaveBeenCalled();
  });

  test("a row offers no Stop using here or Disconnect: those are on the plugin's page", async () => {
    plugins = [GMAIL];
    mounted = await mount();
    const r = row(mounted.container, "person:gmail")!;
    expect(r.querySelectorAll("button")).toHaveLength(0);
    expect(r.textContent).not.toContain("Stop using");
    expect(r.textContent).not.toContain("Disconnect");
  });
});

describe("PluginsPage — a grant changed elsewhere", () => {
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

  test("re-reads the listing and the person's connector records", async () => {
    plugins = [GRANOLA];
    mounted = await mount();
    const state = () =>
      row(mounted!.container, "person:granola")?.querySelector('[data-testid="plugin-state"]')
        ?.textContent;
    expect(state()).toBe("Off here");
    const listings = listPlugins.mock.calls.length;
    const records = listPersonalConnectors.mock.calls.length;

    plugins = [{ ...GRANOLA, granted: true }];
    await act(async () => {
      events?.onEvent("connector.grant_changed", {
        userId: "usr_pat",
        serverName: "granola",
        wsId: WS_ID,
        granted: true,
      });
    });
    await settle();

    expect(listPlugins.mock.calls.length).toBe(listings + 1);
    expect(listPersonalConnectors.mock.calls.length).toBe(records + 1);
    expect(state()).toBe("Pat · on here");
  });
});

describe("PluginsBrowsePage", () => {
  test("is titled Browse plugins, with a link back to Plugins", async () => {
    mounted = await mount({ path: `/w/${SLUG}/plugins/browse` });
    expect(mounted.container.querySelector("h1")?.textContent).toBe("Browse plugins");
    const back = mounted.container.querySelector('[data-testid="browse-back"]')!;
    expect(back.textContent).toBe("← Plugins");
    expect(back.getAttribute("href")).toBe(`/w/${SLUG}/plugins`);
  });

  test("the list has no install buttons: each row opens its entry's page", async () => {
    mounted = await mount({ role: "admin", path: `/w/${SLUG}/plugins/browse` });
    expect(mounted.container.textContent).toContain("Acme Tasks");
    expect(mounted.container.querySelector('[data-testid="directory-entry"] button')).toBeNull();
  });

  test("a row's name opens the entry's page", async () => {
    mounted = await mount({ path: `/w/${SLUG}/plugins/browse` });
    const link = [...mounted.container.querySelectorAll("a")].find(
      (a) => a.textContent === "Acme Tasks",
    );
    // The catalog id's slash stays a path separator, under the route's splat.
    expect(link?.getAttribute("href")).toBe(`/w/${SLUG}/plugins/browse/com.acme/tasks`);
  });

  test("an entry's page says what installing asks for, with the page's Install", async () => {
    mounted = await mount({ role: "admin", path: `/w/${SLUG}/plugins/browse/com.acme/tasks` });
    const page = mounted.container.querySelector('[data-testid="directory-entry-page"]')!;
    expect(page.querySelector("h1")?.textContent).toBe("Acme Tasks");
    // A platform-minted credential: no sign-in and nothing to enter.
    expect(page.textContent).toContain("Nothing more. It connects as soon as it's installed.");
    expect(page.textContent).toContain("one Acme Tasks account for the whole workspace");
    expect(button(page, "Install")?.disabled).toBe(false);
    const back = mounted.container.querySelector('[data-testid="browse-back"]')!;
    expect(back.textContent).toBe("← Browse plugins");
    expect(back.getAttribute("href")).toBe(`/w/${SLUG}/plugins/browse`);
    // The entry's own name is the page's heading, not the directory's.
    expect(mounted.container.textContent).not.toContain("Browse pluginsAcme");
    expect(mounted.container.querySelector('input[type="search"]')).toBeNull();
  });

  test("an entry's page keeps the install gate", async () => {
    mounted = await mount({ role: "member", path: `/w/${SLUG}/plugins/browse/com.acme/tasks` });
    const page = mounted.container.querySelector('[data-testid="directory-entry-page"]')!;
    expect(button(page, "Install")?.disabled).toBe(true);
    expect(page.textContent).toContain("Workspace admin required");
  });

  test("an id the directory lacks says so", async () => {
    mounted = await mount({ path: `/w/${SLUG}/plugins/browse/com.acme/gone` });
    expect(mounted.container.textContent).toContain("This plugin isn't in the directory.");
  });

  test("offers no skill writing: that is on Skills", async () => {
    mounted = await mount({ path: `/w/${SLUG}/plugins/browse` });
    expect(button(mounted.container, "Write a skill")).toBeUndefined();
  });
});
