// ---------------------------------------------------------------------------
// Install on a static-auth entry whose OAuth client is not set up yet.
//
// It is the same Install every entry has: an admin's click opens the OAuth
// client dialog as the install's first step, and saving the client carries on
// into the install. A catalog listing carries the vendor portal and secret key
// under `install.oauthClientSetup`; the dialog renders nothing without them, so
// Browse must hand them over or the button does nothing.
//
// Same plumbing as connector-browse-installed.test.tsx.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";
import type * as ApiClient from "../api/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const STATIC = {
  id: "com.acme/ledger",
  name: "Acme Ledger",
  description: "Acme Ledger tools",
  oauthClientConfigured: false,
  install: {
    kind: "remote-oauth" as const,
    url: "https://ledger.acme.test/mcp",
    transportType: "streamable-http" as const,
    auth: "static" as const,
    oauthClientSetup: {
      portalUrl: "https://developer.acme.test/",
      hint: "Create an OAuth client in the Acme developer portal",
      clientSecretKey: "acme.client_secret",
    },
  },
};

const listDirectory = mock(async () => ({ entries: [STATIC], errors: [] }));
const getInstalledConnectors = mock(async () => ({ installed: [] }));
const getOAuthRedirectUri = mock(async () => ({
  redirectUri: "https://connect.example.test/v1/mcp-auth/callback",
}));
const setConnectorOAuthClient = mock(
  async () => ({}) as Awaited<ReturnType<typeof ApiClient.setConnectorOAuthClient>>,
);
const installConnector = mock(async () => ({
  ok: true,
  alreadyInstalled: false,
  serverName: "com-acme-ledger",
  scope: "workspace" as const,
  wsId: "ws_0076759dbbe19fcc",
}));
// The sign-in an install of a static-auth entry runs next. No URL: connected
// already, so the install finishes on the page instead of leaving it.
const initiateMcpOAuth = mock(
  async () =>
    ({ authorizationUrl: null }) as Awaited<ReturnType<typeof ApiClient.initiateMcpOAuth>>,
);

mock.module("../api/client", () => ({
  ...realClient,
  listDirectory,
  getInstalledConnectors,
  getOAuthRedirectUri,
  setConnectorOAuthClient,
  installConnector,
  initiateMcpOAuth,
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");

const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { oauthClientSetupTarget } = await import("../pages/settings/ConnectorBrowsePage");
const { PluginsBrowsePage } = await import("../pages/PluginsBrowsePage");
const { buttonNamed, entryPage, openEntry } = await import("./directory-entry-helpers");

// The viewer administers the workspace, so Install sets the client up. The role comes
// through the real context, as in connector-browse-installed.test.tsx.
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
        <Routes>
          <Route path="/w/:slug/plugins/browse/*" element={<PluginsBrowsePage />} />
        </Routes>
      </MemoryRouter>
    </WorkspaceProvider>
  );
}

let unmount: (() => void) | null = null;
afterEach(() => {
  unmount?.();
  unmount = null;
});

async function mount(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(<Page />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  unmount = () => {
    root.unmount();
    container.remove();
  };
  return container;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setVal?.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function openSetup(container: HTMLElement): Promise<HTMLElement | null> {
  const page = await openEntry(container, "Acme Ledger");
  // The same Install every entry has; no separate Set up.
  expect(buttonNamed(page, "Set up")).toBeNull();
  await act(async () => {
    buttonNamed(page, "Install")?.click();
  });
  return container.querySelector<HTMLElement>('[role="dialog"]');
}

describe("Install on a static-auth connector awaiting its OAuth client", () => {
  test("opens the OAuth client dialog with the vendor portal, installing nothing yet", async () => {
    const container = await mount();
    const dialog = await openSetup(container);
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Client ID");
    expect(dialog?.querySelector('a[href="https://developer.acme.test/"]')).not.toBeNull();
    expect(installConnector).not.toHaveBeenCalled();
  });

  test("saving the client carries on into the install", async () => {
    const container = await mount();
    const dialog = await openSetup(container);
    await act(async () => {
      setInputValue(dialog!.querySelector<HTMLInputElement>("#oauth-client-id")!, "cid");
      setInputValue(dialog!.querySelector<HTMLInputElement>("#oauth-client-secret")!, "sec");
    });
    await act(async () => {
      buttonNamed(dialog!, "Save and install")?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });
    expect(setConnectorOAuthClient).toHaveBeenCalledTimes(1);
    expect(installConnector).toHaveBeenCalledTimes(1);
    expect(buttonNamed(entryPage(container)!, "Installed")).not.toBeNull();
  });
});

describe("oauthClientSetupTarget", () => {
  test("lifts oauthClientSetup out of the install", () => {
    expect(oauthClientSetupTarget(STATIC)).toEqual({
      id: "com.acme/ledger",
      name: "Acme Ledger",
      oauthClientSetup: STATIC.install.oauthClientSetup,
    });
  });
});
