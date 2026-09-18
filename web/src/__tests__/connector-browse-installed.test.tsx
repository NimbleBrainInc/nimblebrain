// ---------------------------------------------------------------------------
// Browse shows what the workspace already has, and an install that needs no
// sign-in finishes on Browse.
//
// Installed entries render in their own muted section rather than vanishing,
// so the directory answers "do we have this?" on its own. A brokered install
// stores a per-install session URL, so it is matched to its directory entry by
// catalog id — a URL-only match would leave it offered for install again.
//
// A provider install stays on the page: the button spins, then reads Installed.
// The exception is an install that came back with a warning: that connector is
// not working, and Configure is where its state renders, so it goes there.
//
// Same plumbing as connector-secret-install.test.tsx.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

{
  const win = (globalThis as unknown as { window: Record<string, unknown> }).window;
  if (win) {
    win.SyntaxError ??= SyntaxError;
    win.TypeError ??= TypeError;
  }
}

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

const listDirectory = mock(async () => ({ entries: [TASKS, BROKERED], errors: [] }));
const getInstalledConnectors = mock(async () => ({ installed }));
const installConnector = mock(async () => ({
  ok: true,
  alreadyInstalled: false,
  serverName: "com-acme-tasks",
  scope: "workspace" as const,
  wsId: "ws_test",
  ...(installWarning ? { warning: installWarning } : {}),
}));

mock.module("../api/client", () => ({
  ...realClient,
  listDirectory,
  getInstalledConnectors,
  installConnector,
}));

mock.module("../hooks/useScopedRole", () => ({
  useCanWriteActiveWorkspace: () => true,
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");

const { ConnectorBrowsePage, INSTALL_MIN_SPINNER_MS } = await import(
  "../pages/settings/ConnectorBrowsePage"
);

let lastPath = "";

function LocationProbe() {
  lastPath = useLocation().pathname;
  return null;
}

function Page() {
  return (
    <MemoryRouter initialEntries={["/w/acme/settings/connectors/browse"]}>
      <LocationProbe />
      <Routes>
        <Route path="/w/:slug/settings/connectors/browse" element={<ConnectorBrowsePage />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>
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

/** The card element holding `name`. */
function card(container: HTMLElement, name: string): HTMLElement {
  const title = Array.from(container.querySelectorAll("div")).find((d) => d.textContent === name);
  const found = title?.closest(".border") as HTMLElement | null | undefined;
  if (!found) throw new Error(`no card for ${name}`);
  return found;
}

function buttonIn(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector("button");
}

function installedSection(container: HTMLElement): HTMLElement | null {
  return container.querySelector("section");
}

describe("Browse lists installed connectors", () => {
  test("an installed entry sits in the Installed section, not offered for install", async () => {
    installed = [
      { serverName: "com-acme-tasks", url: "https://tasks.acme.test/mcp", catalogId: null },
    ];
    mounted = await mount(<Page />);
    const section = installedSection(mounted.container);
    expect(section?.textContent).toContain("Acme Tasks");
    expect(buttonIn(card(mounted.container, "Acme Tasks"))?.textContent).toContain("Installed");
    // The other entry is still offered, above the section.
    expect(section?.textContent).not.toContain("Acme Brokered");
    expect(buttonIn(card(mounted.container, "Acme Brokered"))?.textContent).toBe("Install");
  });

  test("a brokered install whose URL differs still matches, by catalog id", async () => {
    installed = [
      {
        serverName: "com-acme-brokered",
        url: "https://broker.example.test/session/abc",
        catalogId: "com.acme/brokered",
      },
    ];
    mounted = await mount(<Page />);
    expect(installedSection(mounted.container)?.textContent).toContain("Acme Brokered");
    const link = card(mounted.container, "Acme Brokered").querySelector("a");
    expect(link?.getAttribute("href")).toBe("/w/acme/settings/connectors/com-acme-brokered");
  });
});

describe("installing a provider connector", () => {
  test("spins, then reads Installed in place, without leaving Browse", async () => {
    mounted = await mount(<Page />);
    await act(async () => {
      buttonIn(card(mounted!.container, "Acme Tasks"))?.click();
    });
    const pending = buttonIn(card(mounted.container, "Acme Tasks"));
    expect(pending?.textContent).toContain("Installing…");
    expect(pending?.disabled).toBe(true);

    await act(async () => {
      await new Promise((r) => setTimeout(r, INSTALL_MIN_SPINNER_MS + 50));
    });
    const done = buttonIn(card(mounted.container, "Acme Tasks"));
    expect(done?.textContent).toContain("Installed");
    expect(done?.disabled).toBe(true);
    expect(lastPath).toBe("/w/acme/settings/connectors/browse");
    // Stays in the grid for this visit rather than jumping to the section.
    expect(installedSection(mounted.container)).toBeNull();
  });

  test("an install that came back with a warning goes to Configure", async () => {
    installWarning = "Installed, but the connector failed to start.";
    mounted = await mount(<Page />);
    await act(async () => {
      buttonIn(card(mounted!.container, "Acme Tasks"))?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(lastPath).toBe("/w/acme/settings/connectors/com-acme-tasks");
  });
});
