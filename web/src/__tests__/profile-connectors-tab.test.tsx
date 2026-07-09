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

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let nextConnectors: PersonalConnector[] = [];
let nextCatalog: DirectoryEntry[] = [];
let nextError: Error | null = null;
const listPersonalConnectors = mock(async () => {
  if (nextError) throw nextError;
  return { connectors: nextConnectors };
});
const listPersonalCatalog = mock(async () => ({ catalog: nextCatalog }));
const installPersonalConnector = mock(async () => ({
  ok: true,
  serverName: "granola",
  scope: "identity" as const,
}));
const initiateIdentityConnect = mock(async () => ({
  authorizationUrl: "https://vendor.test/auth",
}));

mock.module("../api/client", () => ({
  ...realClient,
  listPersonalConnectors,
  listPersonalCatalog,
  installPersonalConnector,
  initiateIdentityConnect,
}));

const React = await import("react");
const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ProfileConnectorsTab } = await import("../pages/settings/ProfileConnectorsTab");

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
  nextConnectors = [];
  nextCatalog = [];
  nextError = null;
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
        grantedWorkspaces: ["ws_helix"],
      },
      {
        serverName: "gmail",
        displayName: "Gmail",
        description: null,
        state: "not_authenticated",
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

  test("shows an error state when the list load fails", async () => {
    nextError = new Error("boom");
    mounted = await mount();
    const text = mounted.container.textContent ?? "";
    expect(text).toContain("Unable to load connectors");
    expect(text).toContain("boom");
  });
});
