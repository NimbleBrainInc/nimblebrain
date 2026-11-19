// ---------------------------------------------------------------------------
// ChatPluginsProvider — the listing a timeline row reads.
//
// Pins:
//   1. A consumer sees the listing for the chat's workspace once it lands.
//   2. On a workspace switch, a slow read for the old workspace that lands
//      after the new one's never replaces it, and the old listing is not
//      served while the new read is in flight.
//   3. A connector install or uninstall re-reads the listing.
//   4. A failed read labels nothing at first, and keeps the last listing
//      after a later failure.
//
// `listPlugins` is mocked with one deferred per call, so each test settles
// reads in the order it chooses. The events stream is driven through the real
// events-client singleton's `setConnectorForTest` seam, as
// workspace-unread.test.tsx does.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { realClient } from "../../test/setup";
import type { Plugin, PluginsListOutput } from "../_generated/platform-schemas/plugins";
import { __internal__ } from "../api/events-client";
import type { ConnectEventsOptions, EventConnection } from "../api/sse";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const WS_A = "ws_00a1b2c3d4e5f607";
const WS_B = "ws_00f7e6d5c4b3a291";

interface PendingRead {
  wsId: string;
  resolve: (out: PluginsListOutput) => void;
  reject: (err: Error) => void;
}
let reads: PendingRead[] = [];

mock.module("../api/client", () => ({
  ...realClient,
  listPlugins: mock(
    (wsId: string) =>
      new Promise<PluginsListOutput>((resolve, reject) => {
        reads.push({ wsId, resolve, reject });
      }),
  ),
}));

const ReactDOMClient = await import("react-dom/client");
const { act } = await import("react");
const { ChatPluginsProvider } = await import("../context/ChatPluginsProvider");
const { useChatPlugins } = await import("../context/ChatPluginsContext");

class FakeConnection implements EventConnection {
  close(): void {}
}
let lastOptions: ConnectEventsOptions | null = null;

function plugin(displayName: string): Plugin {
  return {
    id: `workspace:${displayName}`,
    displayName,
    owner: { kind: "workspace" },
    granted: true,
    servers: [{ serverName: displayName.toLowerCase(), status: "ready", account: null }],
    skills: [],
    apps: [],
  };
}

let seen: string[] = [];
function Probe() {
  seen = useChatPlugins().map((p) => p.displayName);
  return null;
}

let container: HTMLDivElement;
let root: ReturnType<typeof ReactDOMClient.createRoot>;

async function render(workspaceId: string): Promise<void> {
  await act(async () => {
    root.render(
      <ChatPluginsProvider workspaceId={workspaceId}>
        <Probe />
      </ChatPluginsProvider>,
    );
  });
}

async function settle(read: PendingRead | undefined, names: string[]): Promise<void> {
  await act(async () => {
    read?.resolve({ wsId: read.wsId, plugins: names.map(plugin) });
  });
}

async function fail(read: PendingRead | undefined): Promise<void> {
  await act(async () => {
    read?.reject(new Error("listing unavailable"));
  });
}

beforeEach(() => {
  reads = [];
  seen = [];
  lastOptions = null;
  __internal__.resetForTest();
  __internal__.setConnectorForTest((options: ConnectEventsOptions) => {
    lastOptions = options;
    return new FakeConnection();
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = ReactDOMClient.createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __internal__.resetForTest();
  __internal__.setConnectorForTest(null);
});

describe("ChatPluginsProvider", () => {
  test("serves the listing for the chat's workspace once it lands", async () => {
    await render(WS_A);
    expect(reads.map((r) => r.wsId)).toEqual([WS_A]);
    expect(seen).toEqual([]);

    await settle(reads[0], ["Gmail"]);
    expect(seen).toEqual(["Gmail"]);
  });

  test("a switch never serves the old workspace's listing", async () => {
    await render(WS_A);
    await settle(reads[0], ["Gmail"]);

    await render(WS_B);
    expect(reads.map((r) => r.wsId)).toEqual([WS_A, WS_B]);
    // The old listing is not served while the new read is in flight.
    expect(seen).toEqual([]);
    await settle(reads[1], ["Slack"]);
    expect(seen).toEqual(["Slack"]);
  });

  test("a read for the old workspace that lands after the switch is dropped", async () => {
    await render(WS_A);
    await render(WS_B);
    const [slowA, fastB] = reads;
    await settle(fastB, ["Slack"]);
    expect(seen).toEqual(["Slack"]);
    await settle(slowA, ["Gmail"]);
    expect(seen).toEqual(["Slack"]);
  });

  test("a connector install or uninstall re-reads the listing", async () => {
    await render(WS_A);
    await settle(reads[0], ["Gmail"]);

    await act(async () => {
      lastOptions?.onEvent("connector.installed", {
        wsId: WS_A,
        serverName: "slack",
        connectorName: "slack",
        version: "1.0.0",
        ui: null,
        placements: null,
      });
    });
    expect(reads.map((r) => r.wsId)).toEqual([WS_A, WS_A]);
    await settle(reads[1], ["Gmail", "Slack"]);
    expect(seen).toEqual(["Gmail", "Slack"]);

    await act(async () => {
      lastOptions?.onEvent("connector.uninstalled", {
        wsId: WS_A,
        serverName: "gmail",
        connectorName: "gmail",
      });
    });
    expect(reads.map((r) => r.wsId)).toEqual([WS_A, WS_A, WS_A]);
    await settle(reads[2], ["Slack"]);
    expect(seen).toEqual(["Slack"]);
  });

  test("a failed read labels nothing, and a later failure keeps the last listing", async () => {
    await render(WS_A);
    await fail(reads[0]);
    expect(seen).toEqual([]);

    await act(async () => {
      lastOptions?.onEvent("connector.installed", {
        wsId: WS_A,
        serverName: "gmail",
        connectorName: "gmail",
        version: "1.0.0",
        ui: null,
        placements: null,
      });
    });
    await settle(reads[1], ["Gmail"]);
    expect(seen).toEqual(["Gmail"]);

    await act(async () => {
      lastOptions?.onEvent("connector.uninstalled", {
        wsId: WS_A,
        serverName: "gmail",
        connectorName: "gmail",
      });
    });
    await fail(reads[2]);
    expect(seen).toEqual(["Gmail"]);
  });
});
