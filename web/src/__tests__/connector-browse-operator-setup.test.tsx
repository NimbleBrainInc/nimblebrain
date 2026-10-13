// ---------------------------------------------------------------------------
// Set up on a static-auth card opens the operator OAuth dialog.
//
// A catalog listing carries the vendor portal and secret key under
// `install.operatorSetup`; the dialog renders nothing without them, so Browse
// must hand them over or the button does nothing.
//
// Same plumbing as connector-browse-installed.test.tsx.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, mock, test } from "bun:test";
import { defineHappyDomErrorClasses } from "../../test/happy-dom";
import { realClient } from "../../test/setup";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

defineHappyDomErrorClasses();

const STATIC = {
  id: "com.acme/ledger",
  name: "Acme Ledger",
  description: "Acme Ledger tools",
  operatorConfigured: false,
  install: {
    kind: "remote-oauth" as const,
    url: "https://ledger.acme.test/mcp",
    transportType: "streamable-http" as const,
    auth: "static" as const,
    operatorSetup: {
      portalUrl: "https://developer.acme.test/",
      hint: "Create an OAuth app in the Acme developer portal",
      clientSecretKey: "acme.client_secret",
    },
  },
};

const listDirectory = mock(async () => ({ entries: [STATIC], errors: [] }));
const getInstalledConnectors = mock(async () => ({ installed: [] }));
const getOAuthRedirectUri = mock(async () => ({
  redirectUri: "https://connect.example.test/v1/mcp-auth/callback",
}));

mock.module("../api/client", () => ({
  ...realClient,
  listDirectory,
  getInstalledConnectors,
  getOAuthRedirectUri,
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { MemoryRouter, Route, Routes } = await import("react-router-dom");

const { WorkspaceProvider } = await import("../context/WorkspaceContext");
const { ConnectorBrowsePage, operatorSetupTarget } = await import(
  "../pages/settings/ConnectorBrowsePage"
);

// The viewer administers the workspace, so Browse offers Set up. The role comes
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
      <MemoryRouter initialEntries={["/w/000f7ed6658f9d30/settings/connectors/browse"]}>
        <Routes>
          <Route path="/w/:slug/settings/connectors/browse" element={<ConnectorBrowsePage />} />
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

describe("Set up on a static-auth connector", () => {
  test("opens the OAuth client dialog with the vendor portal", async () => {
    const container = await mount();
    const setUp = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Set up",
    );
    expect(setUp).toBeDefined();
    await act(async () => {
      setUp?.click();
    });
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Client ID");
    expect(dialog?.querySelector('a[href="https://developer.acme.test/"]')).not.toBeNull();
  });
});

describe("operatorSetupTarget", () => {
  test("lifts operatorSetup out of the install", () => {
    expect(operatorSetupTarget(STATIC)).toEqual({
      id: "com.acme/ledger",
      name: "Acme Ledger",
      operatorSetup: STATIC.install.operatorSetup,
    });
  });
});
