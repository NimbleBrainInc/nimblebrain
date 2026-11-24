// ---------------------------------------------------------------------------
// Browse shows what the workspace already has, and an install that needs no
// sign-in finishes on Browse.
//
// Installed entries render in their own muted section rather than vanishing,
// so the directory answers "do we have this?" on its own. A brokered install
// stores a per-install session URL, so it is matched to its directory entry by
// catalog id — a URL-only match would leave it offered for install again.
//
// Install is on each entry's page. A provider install stays on that page: the
// button spins, then reads Installed, and the entry's row reads Installed too.
// The exception is an install that came back with a warning: that connector is
// not working, and Configure is where its state renders, so it goes there.
//
// Same plumbing as connector-secret-install.test.tsx.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";
import type { Plugin } from "../_generated/platform-schemas/plugins";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

function providerEntry(id: string, name: string, url: string) {
  return {
    id,
    name,
    description: `${name} tools`,
    install: {
      kind: "remote-oauth" as const,
      url,
      transportType: "streamable-http" as const,
      auth: "provider" as const,
      providerAuth: { provider: "minted", config: {} },
    },
  };
}

const TASKS = providerEntry("com.acme/tasks", "Acme Tasks", "https://tasks.acme.test/mcp");
const BROKERED = providerEntry(
  "com.acme/brokered",
  "Acme Brokered",
  "https://catalog.acme.test/mcp",
);

let installed: Array<Record<string, unknown>> = [];
let installWarning: string | undefined;
let plugins: Plugin[] = [];

const listDirectory = mock(async () => ({ entries: [TASKS, BROKERED], errors: [] }));
const getInstalledConnectors = mock(async () => ({ installed }));
const listPlugins = mock(async () => ({ wsId: "ws_000f7ed6658f9d30", plugins }));
const installConnector = mock(async () => ({
  ok: true,
  alreadyInstalled: false,
  serverName: "com-acme-tasks",
  scope: "workspace" as const,
  wsId: "ws_0076759dbbe19fcc",
  ...(installWarning ? { warning: installWarning } : {}),
}));

mock.module("../api/client", () => ({
  ...realClient,
  listDirectory,
  getInstalledConnectors,
  installConnector,
  listPlugins,
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");

const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { INSTALL_MIN_SPINNER_MS } = await import("../pages/settings/ConnectorBrowsePage");
const { PluginsBrowsePage } = await import("../pages/PluginsBrowsePage");
const { buttonNamed, entryPage, entryRow, openEntry } = await import("./directory-entry-helpers");

let lastPath = "";

function LocationProbe() {
  lastPath = useLocation().pathname;
  return null;
}

// The viewer administers the workspace, so Browse offers install. The role
// comes through the real context: `mock.module` is process-wide in bun, so
// mocking the role hook here would make every later web test's user an admin.
const ADMIN_WORKSPACE = {
  id: "ws_0076759dbbe19fcc",
  name: "Acme",
  memberCount: 1,
  connectorCount: 0,
  userRole: "admin" as const,
};

function Page() {
  return (
    <WorkspaceProvider initialWorkspaces={[ADMIN_WORKSPACE]} initialActiveId={ADMIN_WORKSPACE.id}>
      <MemoryRouter initialEntries={["/w/000f7ed6658f9d30/plugins/browse"]}>
        <LocationProbe />
        <Routes>
          <Route path="/w/:slug/plugins/browse/*" element={<PluginsBrowsePage />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </WorkspaceProvider>
  );
}

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
  installed = [];
  plugins = [];
  installWarning = undefined;
  installConnector.mockClear();
  lastPath = "";
});

async function mount(element: React.ReactElement): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}

function installedSection(container: HTMLElement): HTMLElement | null {
  return container.querySelector("section");
}

describe("Browse lists installed connectors", () => {
  test("an installed entry sits in the Installed section, marked Installed", async () => {
    installed = [
      { serverName: "com-acme-tasks", url: "https://tasks.acme.test/mcp", catalogId: null },
    ];
    mounted = await mount(<Page />);
    const section = installedSection(mounted.container);
    expect(section?.textContent).toContain("Acme Tasks");
    expect(entryRow(mounted.container, "Acme Tasks").textContent).toContain("Installed");
    // The other entry is still offered, above the section.
    expect(section?.textContent).not.toContain("Acme Brokered");
    expect(entryRow(mounted.container, "Acme Brokered").textContent).not.toContain("Installed");
    // Its page says so, rather than offering Install again.
    const page = await openEntry(mounted.container, "Acme Tasks");
    expect(buttonNamed(page, "Installed")?.disabled).toBe(true);
    expect(buttonNamed(page, "Install")).toBeNull();
  });

  test("a brokered install whose URL differs still matches, by catalog id", async () => {
    installed = [
      {
        serverName: "com-acme-brokered",
        url: "https://broker.example.test/session/abc",
        catalogId: "com.acme/brokered",
      },
    ];
    plugins = [
      {
        id: "workspace:com-acme-brokered",
        displayName: "Acme Brokered",
        owner: { kind: "workspace" },
        granted: true,
        servers: [{ serverName: "com-acme-brokered", status: "ready", account: null }],
        skills: [],
        apps: [],
      },
    ];
    mounted = await mount(<Page />);
    expect(installedSection(mounted.container)?.textContent).toContain("Acme Brokered");
    // Configure, on its page, opens the plugin's page, by its encoded id.
    const page = await openEntry(mounted.container, "Acme Brokered");
    const configure = Array.from(page.querySelectorAll("a")).find(
      (a) => a.textContent === "Configure",
    );
    expect(configure?.getAttribute("href")).toBe(
      "/w/000f7ed6658f9d30/plugins/workspace%3Acom-acme-brokered",
    );
  });

  test("with no plugin listing, an installed entry still links by its server name", async () => {
    installed = [
      { serverName: "com-acme-tasks", url: "https://tasks.acme.test/mcp", catalogId: null },
    ];
    listPlugins.mockImplementationOnce(async () => {
      throw new Error("down");
    });
    mounted = await mount(<Page />);
    const page = await openEntry(mounted.container, "Acme Tasks");
    const configure = Array.from(page.querySelectorAll("a")).find(
      (a) => a.textContent === "Configure",
    );
    expect(configure?.getAttribute("href")).toBe(
      "/w/000f7ed6658f9d30/settings/connectors/com-acme-tasks",
    );
  });
});

describe("installing a provider connector", () => {
  test("spins, then reads Installed in place, on the entry's page", async () => {
    mounted = await mount(<Page />);
    const page = await openEntry(mounted.container, "Acme Tasks");
    await act(async () => {
      buttonNamed(page, "Install")?.click();
    });
    expect(buttonNamed(entryPage(mounted.container)!, "Installing…")?.disabled).toBe(true);

    await act(async () => {
      await new Promise((r) => setTimeout(r, INSTALL_MIN_SPINNER_MS + 50));
    });
    expect(buttonNamed(entryPage(mounted.container)!, "Installed")?.disabled).toBe(true);
    expect(lastPath).toBe("/w/000f7ed6658f9d30/plugins/browse/com.acme/tasks");

    // Back on the list, its row reads Installed and keeps its place for this
    // visit rather than jumping to the section.
    const back = mounted.container.querySelector<HTMLAnchorElement>('[data-testid="browse-back"]');
    await act(async () => {
      back?.click();
    });
    expect(entryRow(mounted.container, "Acme Tasks").textContent).toContain("Installed");
    expect(installedSection(mounted.container)).toBeNull();
  });

  test("an install that came back with a warning goes to Configure", async () => {
    installWarning = "Installed, but the connector failed to start.";
    mounted = await mount(<Page />);
    const page = await openEntry(mounted.container, "Acme Tasks");
    await act(async () => {
      buttonNamed(page, "Install")?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(lastPath).toBe("/w/000f7ed6658f9d30/settings/connectors/com-acme-tasks");
  });
});
