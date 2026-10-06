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
import type * as ApiClient from "../api/client";
import type { CatalogListing, PersonalConnector } from "../api/client";
import type { WorkspaceInfo } from "../context/WorkspaceContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let nextConnectors: PersonalConnector[] = [];
let nextCatalog: CatalogListing[] = [];
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
const initiateIdentityConnect = mock<typeof ApiClient.initiateIdentityConnect>(async () => ({
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
const listConnectorToolsWithPermissions = mock(async (serverName: string) => ({
  scope: "user" as const,
  serverName,
  tools: [{ name: "list_notes", description: "List notes", inputSchema: { type: "object" } }],
  permissions: {},
}));

mock.module("../api/client", () => ({
  ...realClient,
  listConnectorToolsWithPermissions,
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

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ProfileConnectorsTab, workspaceReach } = await import(
  "../pages/settings/ProfileConnectorsTab"
);
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
      React.createElement(WorkspaceProvider, {
        initialWorkspaces: workspaces,
        children: React.createElement(ProfileConnectorsTab),
      }),
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

/** Every button on the page, the confirm dialog's portal included. */
const allButtons = () => [...document.body.getElementsByTagName("button")];

/** Open a connector's row by clicking its name, the row's disclosure. */
async function openRow(name: string): Promise<void> {
  await click(allButtons().find((b) => b.textContent === name));
}

function catalogEntry(overrides: Partial<CatalogListing> = {}): CatalogListing {
  return {
    id: "ai.granola/mcp",
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
  listConnectorToolsWithPermissions.mockClear();
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

  test("lists each connector with its state and where it is on", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: "Meeting notes",
        state: "running",
        auth: "dcr",
        grantedWorkspaces: ["ws_003eba8844413cd9"],
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
    expect(text).toContain("On in 1 workspace");

    expect(text).toContain("Gmail");
    expect(text).toContain("Not connected");
    expect(text).toContain("Not on in any workspace");
    // A not-yet-authenticated connector offers a Connect action, not a raw state.
    expect(text).toContain("Connect");
    expect(text).not.toContain("not_authenticated");
  });

  test("names the signed-in account on a connected connector, email before name", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "running",
        auth: "dcr",
        identity: { email: "user@example.com", name: "A User" },
        grantedWorkspaces: [],
      },
      {
        serverName: "gmail",
        displayName: "Gmail",
        description: null,
        state: "running",
        auth: "composio",
        connectorId: "com.google/gmail",
        identity: { name: "other@example.com" },
        grantedWorkspaces: [],
      },
    ];
    mounted = await mount();
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Connected as user@example.com");
    expect(text).not.toContain("A User");
    expect(text).toContain("Connected as other@example.com");
  });

  test("offers to show tools only on a connected connector", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "running",
        auth: "dcr",
        grantedWorkspaces: [],
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
    await openRow("Granola");
    await openRow("Gmail");
    expect(allButtons().filter((b) => b.textContent === "Show tools")).toHaveLength(1);
    expect(mounted.container.textContent ?? "").toContain("Connect Gmail to see its tools.");
  });

  test("lists a personal connector's tools only once Show tools is clicked", async () => {
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
    // Listing tools starts a cold connector, so neither page load nor opening
    // the row may do it.
    expect(listConnectorToolsWithPermissions).not.toHaveBeenCalled();
    await openRow("Granola");
    expect(listConnectorToolsWithPermissions).not.toHaveBeenCalled();

    await click(allButtons().find((b) => b.textContent === "Show tools"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(listConnectorToolsWithPermissions).toHaveBeenCalledWith("granola", "identity");
    expect(mounted.container.textContent ?? "").toContain("list_notes");
  });

  test("pluralizes the workspace count for 2+ workspaces", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "running",
        auth: "dcr",
        grantedWorkspaces: ["ws_003eba8844413cd9", "ws_000f7ed6658f9d30"],
      },
    ];
    mounted = await mount();
    expect(mounted.container.textContent ?? "").toContain("On in 2 workspaces");
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

  test("workspace switches: list the caller's workspaces and turn one on", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "running",
        auth: "dcr",
        grantedWorkspaces: ["ws_003eba8844413cd9"],
      },
    ];
    mounted = await mountWithWorkspaces([
      { id: "ws_003eba8844413cd9", name: "Helix", memberCount: 1, connectorCount: 0 },
      { id: "ws_00488fa17f87e9a3", name: "Mat's workspace", memberCount: 1, connectorCount: 0 },
    ]);
    const container = mounted.container;
    expect(container.textContent ?? "").toContain("On in 1 of 2 workspaces");

    await openRow("Granola");
    const text = container.textContent ?? "";
    expect(text).toContain("Helix");
    expect(text).toContain("Mat's workspace");
    // Every workspace is listed by name alone — none is marked apart.
    expect(text).not.toContain("· personal");

    const switchFor = (ws: string) =>
      container.querySelector(`[role="switch"][aria-label="Use Granola in ${ws}"]`);
    expect(switchFor("Helix")?.getAttribute("aria-checked")).toBe("true");
    expect(switchFor("Mat's workspace")?.getAttribute("aria-checked")).toBe("false");

    await click(switchFor("Mat's workspace"));
    expect(grantConnector).toHaveBeenCalledWith("granola", "ws_00488fa17f87e9a3");
    expect(revokeConnector).not.toHaveBeenCalled();
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
    // The reconnect ran server-side; the in-place refresh now sees it running.
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
    await click(connect);
    await flush();
    expect(initiateIdentityConnect).toHaveBeenCalledWith("granola");
    // Did NOT redirect to a nonexistent auth page…
    expect(locationAssign).not.toHaveBeenCalled();
    // …the row is NOT stuck "Connecting…" — the busy state was cleared…
    expect(mounted.container.textContent ?? "").not.toContain("Connecting");
    // …and the in-place refresh flipped the row to Connected (not just un-stuck).
    expect(mounted.container.textContent ?? "").toContain("Connected");
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

  test("gives a connector with no icon a letter tile, so every row's name lines up", async () => {
    nextConnectors = [
      {
        serverName: "notion",
        displayName: "Notion",
        description: null,
        state: "not_authenticated",
        auth: "dcr",
        grantedWorkspaces: [],
      },
    ];
    mounted = await mount();
    expect(mounted.container.getElementsByTagName("img")).toHaveLength(0);
    const tile = mounted.container.querySelector('[aria-hidden="true"].h-6.w-6');
    expect(tile?.textContent).toBe("N");
  });

  test("Disconnect confirms, calls the API, and refreshes", async () => {
    nextConnectors = [
      {
        serverName: "granola",
        displayName: "Granola",
        description: null,
        state: "running",
        auth: "dcr",
        grantedWorkspaces: ["ws_003eba8844413cd9"],
      },
    ];
    mounted = await mount();
    await openRow("Granola");
    await click(allButtons().find((b) => b.textContent === "Disconnect"));
    await flush();
    // The dialog says what disconnecting takes with it.
    expect(document.body.textContent ?? "").toContain("It turns off in the 1 workspace");
    expect(disconnectPersonalConnector).not.toHaveBeenCalled();

    // Emptied on the post-disconnect refresh so the row goes away.
    nextConnectors = [];
    await click(
      allButtons()
        .filter((b) => b.textContent === "Disconnect")
        .at(-1),
    );
    await flush();
    expect(disconnectPersonalConnector).toHaveBeenCalledWith("granola");
    // Re-fetched after the disconnect.
    expect(listPersonalConnectors.mock.calls.length).toBeGreaterThan(1);
  });

  test("cancelling the Disconnect confirm is a no-op", async () => {
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
    await openRow("Granola");
    await click(allButtons().find((b) => b.textContent === "Disconnect"));
    await flush();
    await click(allButtons().find((b) => b.textContent === "Cancel"));
    await flush();
    expect(disconnectPersonalConnector).not.toHaveBeenCalled();
  });

  test("a failed Disconnect stays in the confirm dialog, with its error", async () => {
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
    disconnectPersonalConnector.mockImplementationOnce(async () => {
      throw new Error("vendor refused the sign-out");
    });
    mounted = await mount();
    await openRow("Granola");
    await click(allButtons().find((b) => b.textContent === "Disconnect"));
    await flush();
    await click(
      allButtons()
        .filter((b) => b.textContent === "Disconnect")
        .at(-1),
    );
    await flush();
    expect(disconnectPersonalConnector).toHaveBeenCalledWith("granola");
    expect(document.querySelector('[role="dialog"]')?.textContent ?? "").toContain(
      "vendor refused the sign-out",
    );
    expect(mounted.container.textContent ?? "").toContain("Granola");
  });
});

describe("workspaceReach", () => {
  const ws = (id: string): WorkspaceInfo => ({ id, name: id, memberCount: 1, connectorCount: 0 });

  test("names where the connector is on, counted against the caller's workspaces", () => {
    expect(workspaceReach([], [ws("a"), ws("b")])).toBe("Not on in any workspace");
    expect(workspaceReach(["a"], [ws("a"), ws("b"), ws("c")])).toBe("On in 1 of 3 workspaces");
    expect(workspaceReach(["a", "b"], [ws("a"), ws("b")])).toBe("On in all workspaces");
    expect(workspaceReach(["a"], [ws("a")])).toBe("On in your workspace");
  });

  test("falls back to a plain count when a grant is outside the known list", () => {
    expect(workspaceReach(["a", "z"], [ws("a"), ws("b")])).toBe("On in 2 workspaces");
    expect(workspaceReach(["a"], [])).toBe("On in 1 workspace");
  });
});
