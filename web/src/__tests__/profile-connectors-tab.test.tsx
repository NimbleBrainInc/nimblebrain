// ---------------------------------------------------------------------------
// ProfileConnectorsTab — render contract.
//
// The Profile → Connectors tab lists the caller's personal connectors (a
// workspace-independent read via `listPersonalConnectors`) with their state +
// grant count, and offers the curated set of personal-connectable connectors
// (`listPersonalCatalog`) each with a Connect action. bun:test +
// react-dom/client + happy-dom.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type { DirectoryEntry, PersonalConnector } from "../api/client";
import type { WorkspaceInfo } from "../context/WorkspaceContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let nextConnectors: PersonalConnector[] = [];
let nextCatalog: DirectoryEntry[] = [];
let nextError: Error | null = null;
let nextCatalogError: Error | null = null;
const listPersonalConnectors = mock(async () => {
  if (nextError) throw nextError;
  return { connectors: nextConnectors };
});
const listPersonalCatalog = mock(async () => {
  if (nextCatalogError) throw nextCatalogError;
  return { catalog: nextCatalog };
});
const installPersonalConnector = mock(async () => ({
  ok: true,
  serverName: "granola",
  scope: "identity" as const,
}));
const initiateIdentityConnect = mock(async () => ({
  authorizationUrl: "https://vendor.test/auth",
}));
const initiateComposioIdentityConnect = mock(async () => ({
  authorizationUrl: "https://composio.test/connect",
}));
const grantConnector = mock(async () => {});
const revokeConnector = mock(async () => {});
const disconnectPersonalConnector = mock(async () => ({
  ok: true,
  scope: "identity" as const,
  serverName: "granola",
  revokedWorkspaces: 0,
}));

mock.module("../api/client", () => ({
  ...realClient,
  listPersonalConnectors,
  listPersonalCatalog,
  installPersonalConnector,
  initiateIdentityConnect,
  initiateComposioIdentityConnect,
  grantConnector,
  revokeConnector,
  disconnectPersonalConnector,
}));

// Connecting leaves the SPA via `window.location.assign`. happy-dom doesn't
// implement navigation, so stub it — the routing tests only care which initiate
// helper ran before the redirect.
const locationAssign = mock((_url: string) => {});
Object.defineProperty(window, "location", {
  configurable: true,
  value: { ...window.location, assign: locationAssign },
});

// Disconnect confirms via window.confirm. Stub it so tests drive the accept /
// cancel branch deterministically (happy-dom returns false by default).
let confirmReturn = true;
const windowConfirm = mock((_msg?: string) => confirmReturn);
Object.defineProperty(window, "confirm", { configurable: true, value: windowConfirm });

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ProfileConnectorsTab } = await import("../pages/settings/ProfileConnectorsTab");
const { WorkspaceProvider } = await import("../context/WorkspaceContext");

interface Mounted {
  container: HTMLDivElement;
  unmount(): void;
}

let mounted: Mounted | null = null;

async function mount(): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(React.createElement(ProfileConnectorsTab));
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

// Mount inside a real `WorkspaceProvider` so `useWorkspaceContext().workspaces`
// resolves — needed for the grant/revoke panel.
async function mountWithWorkspaces(workspaces: WorkspaceInfo[]): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOMClient.createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(
        WorkspaceProvider,
        { initialWorkspaces: workspaces },
        React.createElement(ProfileConnectorsTab),
      ),
    );
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

function click(el: Element | null | undefined): Promise<void> {
  return act(async () => {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function catalogEntry(overrides: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    id: "ai.granola/mcp",
    registryId: "curated",
    registryType: "static",
    name: "Granola",
    description: "Meeting notes and transcripts",
    personal: true,
    install: {
      kind: "remote-oauth",
      url: "https://mcp.granola.ai/mcp",
      transportType: "streamable-http",
      auth: "dcr",
    },
    ...overrides,
  };
}

beforeEach(() => {
  mounted?.unmount();
  mounted = null;
  listPersonalConnectors.mockClear();
  listPersonalCatalog.mockClear();
  initiateIdentityConnect.mockClear();
  initiateComposioIdentityConnect.mockClear();
  installPersonalConnector.mockClear();
  locationAssign.mockClear();
  grantConnector.mockClear();
  revokeConnector.mockClear();
  disconnectPersonalConnector.mockClear();
  windowConfirm.mockClear();
  confirmReturn = true;
  nextConnectors = [];
  nextCatalog = [];
  nextError = null;
  nextCatalogError = null;
});

describe("ProfileConnectorsTab", () => {
  test("shows the empty state when there are no personal connectors", async () => {
    nextConnectors = [];
    mounted = await mount();
    expect(mounted.container.textContent ?? "").toContain("haven't connected any connectors");
  });

  test("lists each connector with its state and grant count", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: "Meeting notes",
        state: "running",
        auth: "dcr",
        grantedWorkspaces: ["ws_helix"],
      },
      {
        serverName: "gmail",
        displayName: "Gmail",
        description: null,
        state: "not_authenticated",
        auth: "dcr",
        grantedWorkspaces: [],
      },
    ];
    mounted = await mount();
    const text = mounted.container.textContent ?? "";

    expect(text).toContain("Granola");
    expect(text).toContain("Connected"); // running → "Connected"
    expect(text).toContain("Granted to 1 workspace");

    expect(text).toContain("Gmail");
    expect(text).toContain("Not granted");
    // A not-yet-authenticated connector offers a Connect action, not a raw state.
    expect(text).toContain("Connect");
    expect(text).not.toContain("not_authenticated");
  });

  test("pluralizes the grant count for 2+ workspaces", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "running",
        auth: "dcr",
        grantedWorkspaces: ["ws_helix", "ws_acme"],
      },
    ];
    mounted = await mount();
    expect(mounted.container.textContent ?? "").toContain("Granted to 2 workspaces");
  });

  test("offers the curated personal catalog with a Connect action", async () => {
    nextConnectors = [];
    nextCatalog = [catalogEntry()];
    mounted = await mount();
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Add a connector");
    expect(text).toContain("Granola");
    expect(text).toContain("Connect");
  });

  test("renders the installed list even if the curated catalog read fails", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "running",
        auth: "dcr",
        grantedWorkspaces: [],
      },
    ];
    nextCatalogError = new Error("catalog boom");
    mounted = await mount();
    const text = mounted.container.textContent ?? "";
    // Installed list (primary content) still renders — not blocked behind a
    // load error — and the secondary picker is simply hidden.
    expect(text).toContain("Granola");
    expect(text).toContain("Connected");
    expect(text).not.toContain("Unable to load connectors");
    expect(text).not.toContain("Add a connector");
  });

  test("grant panel: lists the caller's workspaces and grants into one", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "running",
        auth: "dcr",
        grantedWorkspaces: ["ws_helix"],
      },
    ];
    mounted = await mountWithWorkspaces([
      { id: "ws_helix", name: "Helix", memberCount: 1, bundles: [] },
      { id: "ws_user_x", name: "Home Space", memberCount: 1, bundles: [], isPersonal: true },
    ]);
    const container = mounted.container;
    const buttons = () => [...container.getElementsByTagName("button")];

    // Expand the manage panel via the grant-count toggle.
    await click(buttons().find((b) => b.textContent?.includes("Granted to 1 workspace")));

    const text = container.textContent ?? "";
    expect(text).toContain("Helix");
    expect(text).toContain("Home Space");
    // The personal workspace is listed like any other (marked, not special-cased).
    expect(text).toContain("personal");
    // Already-granted workspace → Revoke; ungranted → Grant.
    expect(buttons().some((b) => b.textContent === "Revoke")).toBe(true);

    await click(buttons().find((b) => b.textContent === "Grant"));
    expect(grantConnector).toHaveBeenCalledWith("granola", "ws_user_x");
  });

  test("shows an error state when the list load fails", async () => {
    nextError = new Error("boom");
    mounted = await mount();
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Unable to load connectors");
    expect(text).toContain("boom");
  });

  // A flush deep enough for the two-await Connect chain (initiate → assign).
  const flush = () =>
    act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

  test("routes a DCR connector's Connect to the OAuth identity initiate (keyed on serverName)", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "not_authenticated",
        auth: "dcr",
        grantedWorkspaces: [],
      },
    ];
    mounted = await mount();
    const connect = [...mounted.container.getElementsByTagName("button")].find(
      (b) => b.textContent === "Connect",
    );
    await click(connect);
    await flush();
    expect(initiateIdentityConnect).toHaveBeenCalledWith("granola");
    expect(initiateComposioIdentityConnect).not.toHaveBeenCalled();
    expect(locationAssign).toHaveBeenCalledWith("https://vendor.test/auth");
  });

  test("routes a composio connector's Connect to the composio identity initiate (keyed on the connectorId)", async () => {
    nextConnectors = [
      {
        serverName: "gmail",
        displayName: "Gmail",
        description: null,
        state: "not_authenticated",
        auth: "composio",
        connectorId: "com.google/gmail",
        grantedWorkspaces: [],
      },
    ];
    mounted = await mount();
    const connect = [...mounted.container.getElementsByTagName("button")].find(
      (b) => b.textContent === "Connect",
    );
    await click(connect);
    await flush();
    expect(initiateComposioIdentityConnect).toHaveBeenCalledWith("com.google/gmail");
    expect(initiateIdentityConnect).not.toHaveBeenCalled();
    expect(locationAssign).toHaveBeenCalledWith("https://composio.test/connect");
  });

  test("Connect on an already-authenticated connector refreshes in place — no navigation, button not stuck busy (#679)", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "not_authenticated",
        auth: "dcr",
        grantedWorkspaces: [],
      },
    ];
    // startAuth reconnected the connector without an interactive flow — no URL.
    initiateIdentityConnect.mockResolvedValueOnce({ authorizationUrl: null });
    mounted = await mount();
    const connect = [...mounted.container.getElementsByTagName("button")].find(
      (b) => b.textContent === "Connect",
    );
    await click(connect);
    await flush();
    expect(initiateIdentityConnect).toHaveBeenCalledWith("granola");
    // Did NOT redirect to a nonexistent auth page…
    expect(locationAssign).not.toHaveBeenCalled();
    // …and the row is NOT stuck "Connecting…" — the busy state was cleared (the
    // non-navigating success path resets it itself).
    expect(mounted.container.textContent ?? "").not.toContain("Connecting");
  });

  test("renders an installed connector's icon from iconUrl", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: "Meeting notes",
        iconUrl: "https://static.test/granola.png",
        state: "running",
        auth: "dcr",
        grantedWorkspaces: [],
      },
    ];
    mounted = await mount();
    const imgs = [...mounted.container.getElementsByTagName("img")];
    expect(imgs.some((i) => i.getAttribute("src") === "https://static.test/granola.png")).toBe(
      true,
    );
  });

  test("Disconnect confirms, calls the API, and refreshes", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "running",
        auth: "dcr",
        grantedWorkspaces: ["ws_helix"],
      },
    ];
    mounted = await mount();
    const disconnect = [...mounted.container.getElementsByTagName("button")].find(
      (b) => b.textContent === "Disconnect",
    );
    // Emptied on the post-disconnect refresh so the row goes away.
    nextConnectors = [];
    await click(disconnect);
    await flush();
    expect(windowConfirm).toHaveBeenCalled();
    expect(disconnectPersonalConnector).toHaveBeenCalledWith("granola");
    // Re-fetched after the disconnect.
    expect(listPersonalConnectors.mock.calls.length).toBeGreaterThan(1);
  });

  test("cancelling the Disconnect confirm is a no-op", async () => {
    confirmReturn = false;
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "running",
        auth: "dcr",
        grantedWorkspaces: [],
      },
    ];
    mounted = await mount();
    const disconnect = [...mounted.container.getElementsByTagName("button")].find(
      (b) => b.textContent === "Disconnect",
    );
    await click(disconnect);
    await flush();
    expect(windowConfirm).toHaveBeenCalled();
    expect(disconnectPersonalConnector).not.toHaveBeenCalled();
  });
});
