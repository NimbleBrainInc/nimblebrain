// ---------------------------------------------------------------------------
// Plugins → Browse asks whom an install is for (ADR-0069).
//
// "Just me" (the default) installs on the viewer's own account and grants it
// into this workspace in the same call, before the sign-in leaves the page, so
// the grant is in place whatever the OAuth return does. "Everyone in <ws>" is
// the workspace install, offered only to a member who may write the workspace.
// An entry that cannot hold a per-person credential is a workspace install
// only, and its card says why.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";
import type * as ApiClient from "../api/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const WS_ID = "ws_0076759dbbe19fcc";
const SLUG = "0076759dbbe19fcc";

function dcrEntry(
  id: string,
  name: string,
  personalInstallable: boolean,
): ApiClient.CatalogListing {
  return {
    id,
    name,
    description: `${name} tools`,
    personalInstallable,
    install: {
      kind: "remote-oauth",
      url: `https://${name.toLowerCase()}.test/mcp`,
      transportType: "streamable-http",
      auth: "dcr",
    },
  };
}

const NOTES = dcrEntry("com.acme/notes", "Notes", true);
const SHARED = dcrEntry("com.acme/shared", "Shared", false);

const calls: string[] = [];
let authorizationUrl: string | null = "https://auth.notes.test/authorize";
let personalAlreadyInstalled = false;
let personalState = "not_authenticated";

const listDirectory = mock<typeof ApiClient.listDirectory>(async () => ({
  entries: [NOTES, SHARED],
  errors: [],
}));
let workspaceInstalled: ApiClient.InstalledConnector[] = [];
const getInstalledConnectors = mock<typeof ApiClient.getInstalledConnectors>(async () => ({
  installed: workspaceInstalled,
}));
const installConnector = mock<typeof ApiClient.installConnector>(async (entry) => {
  calls.push(`installConnector:${entry.id}`);
  return {
    ok: true,
    alreadyInstalled: false,
    serverName: "com-acme-notes",
    scope: "workspace",
    wsId: WS_ID,
  };
});
const initiateMcpOAuth = mock<typeof ApiClient.initiateMcpOAuth>(async (serverName) => {
  calls.push(`initiateMcpOAuth:${serverName}`);
  return { authorizationUrl: "https://auth.notes.test/workspace" };
});
const installPersonalConnector = mock<typeof ApiClient.installPersonalConnector>(
  async (entry, grantWsId) => {
    calls.push(`installPersonalConnector:${entry.id}:${grantWsId}`);
    return {
      ok: true,
      alreadyInstalled: personalAlreadyInstalled,
      serverName: "com-acme-notes",
      scope: "identity",
      ...(grantWsId ? { grantedWsId: grantWsId } : {}),
    };
  },
);
const initiateIdentityConnect = mock<typeof ApiClient.initiateIdentityConnect>(
  async (serverName, returnWorkspaceId) => {
    // The workspace the sign-in returns to rides with the call.
    calls.push(`initiateIdentityConnect:${serverName}@${returnWorkspaceId}`);
    return { authorizationUrl };
  },
);
const listPersonalConnectors = mock<typeof ApiClient.listPersonalConnectors>(async () => ({
  connectors: [
    {
      serverName: "com-acme-notes",
      displayName: "Notes",
      description: null,
      state: personalState,
      auth: "dcr",
      grantedWorkspaces: [WS_ID],
    },
  ],
}));

mock.module("../api/client", () => ({
  ...realClient,
  listDirectory,
  getInstalledConnectors,
  installConnector,
  initiateMcpOAuth,
  installPersonalConnector,
  initiateIdentityConnect,
  listPersonalConnectors,
}));

// The sign-in leaves the SPA via `window.location.assign`, which happy-dom does
// not implement. The stub records the order against the install calls.
const locationAssign = mock((url: string) => {
  calls.push(`assign:${url}`);
});
const realLocation = window.location;
Object.defineProperty(window, "location", {
  configurable: true,
  value: { ...realLocation, assign: locationAssign },
});
afterAll(() => {
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { PERSONAL_CONNECTORS_PATH } = await import("../pages/settings/ConnectorBrowsePage");
const { PluginsBrowsePage } = await import("../pages/PluginsBrowsePage");
const { buttonNamed, entryRow, openEntry } = await import("./directory-entry-helpers");

function workspace(userRole: "admin" | "member") {
  return { id: WS_ID, name: "Acme", memberCount: 2, connectorCount: 0, userRole };
}

function Page({ role }: { role: "admin" | "member" }) {
  const ws = workspace(role);
  return (
    <WorkspaceProvider initialWorkspaces={[ws]} initialActiveId={ws.id}>
      <MemoryRouter initialEntries={[`/w/${SLUG}/plugins/browse`]}>
        <Routes>
          <Route path="/w/:slug/plugins/browse/*" element={<PluginsBrowsePage />} />
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
  calls.length = 0;
  authorizationUrl = "https://auth.notes.test/authorize";
  personalAlreadyInstalled = false;
  personalState = "not_authenticated";
  workspaceInstalled = [];
});

async function mount(role: "admin" | "member"): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(<Page role={role} />);
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

function button(root: ParentNode, text: string): HTMLButtonElement | null {
  const match = Array.from(root.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  );
  return (match as HTMLButtonElement | undefined) ?? null;
}

/** The Configure link on an entry's page. */
function configureLink(page: HTMLElement): HTMLAnchorElement | undefined {
  return Array.from(page.querySelectorAll("a")).find((a) => a.textContent === "Configure");
}

/** The dialog's own Install, not the page's. */
function confirmButton(): HTMLButtonElement | null {
  const dialog = document.querySelector('[role="dialog"]');
  return dialog ? button(dialog, "Install") : null;
}

function radios(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[name="install-audience"]'));
}

async function click(el: HTMLElement | null) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.click();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Plugins → Browse: whom an install is for", () => {
  test("Install asks, opening on Just me, with Everyone in the workspace beside it", async () => {
    mounted = await mount("admin");
    const page = await openEntry(mounted.container, "Notes");
    await click(buttonNamed(page, "Install"));
    const options = radios();
    expect(options.map((r) => r.value)).toEqual(["personal", "workspace"]);
    expect(options[0]?.checked).toBe(true);
    expect(document.body.textContent).toContain("Just me");
    expect(document.body.textContent).toContain("Everyone in Acme");
    expect(calls).toEqual([]);
  });

  test("Just me installs personally, granted here, before the sign-in leaves the page", async () => {
    mounted = await mount("admin");
    const page = await openEntry(mounted.container, "Notes");
    await click(buttonNamed(page, "Install"));
    await click(confirmButton());
    // The grant rides the install call, so it is written before the redirect:
    // when the OAuth callback brings the person back, there is nothing left to
    // grant, and a person who abandons the sign-in still has it on here.
    expect(calls).toEqual([
      `installPersonalConnector:com.acme/notes:${WS_ID}`,
      `initiateIdentityConnect:com-acme-notes@${WS_ID}`,
      "assign:https://auth.notes.test/authorize",
    ]);
  });

  test("Just me on a connector already connected skips the sign-in and reads Installed", async () => {
    personalAlreadyInstalled = true;
    personalState = "running";
    mounted = await mount("admin");
    const page = await openEntry(mounted.container, "Notes");
    await click(buttonNamed(page, "Install"));
    await click(confirmButton());
    // The install call still grants it here; a Connect on a live connection
    // would be refused as busy, so none is made.
    expect(calls).toEqual([`installPersonalConnector:com.acme/notes:${WS_ID}`]);
    expect(buttonNamed(page, "Installed")?.disabled).toBe(true);
    expect(configureLink(page)?.getAttribute("href")).toBe(PERSONAL_CONNECTORS_PATH);
  });

  test("Everyone here installs into the workspace as before", async () => {
    mounted = await mount("admin");
    const page = await openEntry(mounted.container, "Notes");
    await click(buttonNamed(page, "Install"));
    const everyone = radios().find((r) => r.value === "workspace");
    await click(everyone ?? null);
    await click(confirmButton());
    expect(calls).toEqual([
      "installConnector:com.acme/notes",
      "initiateMcpOAuth:com-acme-notes",
      "assign:https://auth.notes.test/workspace",
    ]);
  });

  test("an entry the workspace already has still offers the viewer's own install", async () => {
    workspaceInstalled = [
      { serverName: "com-acme-notes", catalogId: NOTES.id } as ApiClient.InstalledConnector,
    ];
    mounted = await mount("member");
    const page = await openEntry(mounted.container, "Notes");
    expect(configureLink(page)?.getAttribute("href")).toBe(
      `/w/${SLUG}/settings/connectors/com-acme-notes`,
    );
    await click(buttonNamed(page, "Install for me"));
    // Only Just me: the workspace's own install is already there.
    expect(radios().map((r) => r.value)).toEqual(["personal"]);
    expect(document.body.textContent).toContain("Everyone in Acme already uses it");
    await click(confirmButton());
    expect(calls).toEqual([
      `installPersonalConnector:com.acme/notes:${WS_ID}`,
      `initiateIdentityConnect:com-acme-notes@${WS_ID}`,
      "assign:https://auth.notes.test/authorize",
    ]);
  });

  test("an entry that can't take a per-person credential installs for the workspace, and says why", async () => {
    mounted = await mount("admin");
    expect(entryRow(mounted.container, "Shared").textContent).toContain(
      "Uses one account for the workspace",
    );
    const page = await openEntry(mounted.container, "Shared");
    await click(buttonNamed(page, "Install"));
    // No question to ask: the only choice is the workspace.
    expect(radios()).toHaveLength(0);
    expect(calls[0]).toBe("installConnector:com.acme/shared");
  });

  test("a member who may not write the workspace can install for themselves only", async () => {
    mounted = await mount("member");
    const page = await openEntry(mounted.container, "Notes");
    await click(buttonNamed(page, "Install"));
    expect(radios().map((r) => r.value)).toEqual(["personal"]);
    expect(document.body.textContent).not.toContain("Everyone in Acme");
    expect(document.body.textContent).toContain("A workspace admin can install it for everyone");
  });

  test("a member who may not write the workspace, on a workspace-only entry, is told why", async () => {
    mounted = await mount("member");
    expect(entryRow(mounted.container, "Shared").textContent).toContain(
      "Uses one account for the workspace",
    );
    const page = await openEntry(mounted.container, "Shared");
    expect(buttonNamed(page, "Install")?.disabled).toBe(true);
    expect(page.textContent).toContain("Workspace admin required");
  });
});
